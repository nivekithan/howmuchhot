import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { tileTemplate, type Manifest } from "@howmuchhot/tiles";
import { decodeTile } from "./numeric.ts";
import { temperatureColorShader } from "./colors.ts";

const vertex = `#version 300 es
in vec2 position;
uniform mat4 matrix;
uniform vec3 tile;
out vec2 uv;
void main() {
  uv = position;
  gl_Position = matrix * vec4((tile.xy + position) / tile.z, 0., 1.);
}`;
const fragment = `#version 300 es
precision highp float;
uniform highp sampler2D before;
uniform highp sampler2D after;
uniform float fraction;
uniform vec2 range;
in vec2 uv;
out vec4 color;
${temperatureColorShader}
float temperature(highp sampler2D image) {
  vec2 bytes = texture(image, uv).rg;
  return (dot(bytes, vec2(65280., 255.)) - 32768.) * .01;
}
void main() {
  float value = mix(temperature(before), temperature(after), fraction);
  vec3 fill = temperatureColor(value / (value < 0. ? -range.x : range.y));
  color = vec4(fill, 1.);
}`;

type Tile = { z: number; x: number; y: number; before: string; after: string };

/** Only the visible tiles and the two surrounding hourly snapshots live on the GPU. */
export class TemperatureLayer implements CustomLayerInterface {
  id = "temperature";
  type = "custom" as const;
  renderingMode = "2d" as const;
  missing = false;
  private map!: MapLibreMap;
  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private buffer!: WebGLBuffer;
  private textures = new Map<string, WebGLTexture>();
  private tiles: Tile[] = [];
  private fraction = 0;
  private signature = "";
  private pending: { signature: string; promise: Promise<boolean> } | undefined;
  private generation = 0;
  private controller = new AbortController();

  private manifest: Manifest;

  constructor(manifest: Manifest) {
    this.manifest = manifest;
  }

  onAdd(map: MapLibreMap, context: WebGLRenderingContext | WebGL2RenderingContext) {
    if (!(context instanceof WebGL2RenderingContext)) throw new Error("WebGL 2 is required");
    this.map = map;
    const gl = (this.gl = context);
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? "Shader failed");
      return shader;
    };
    this.program = gl.createProgram()!;
    const shaders = [compile(gl.VERTEX_SHADER, vertex), compile(gl.FRAGMENT_SHADER, fragment)];
    for (const shader of shaders) gl.attachShader(this.program, shader);
    gl.linkProgram(this.program);
    for (const shader of shaders) gl.deleteShader(shader);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      throw new Error("Temperature shader linking failed");
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );
    const location = gl.getAttribLocation(this.program, "position");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private visible() {
    const z = Math.min(3, Math.max(0, Math.floor(this.map.getZoom())));
    const n = 2 ** z;
    const bounds = this.map.getBounds();
    const row = (latitude: number) => {
      const radians = (Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI) / 180;
      return ((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * n;
    };
    const clamp = (v: number) => Math.max(0, Math.min(n - 1, Math.floor(v)));
    const tiles: { z: number; x: number; y: number }[] = [];
    for (
      let x = clamp(((bounds.getWest() + 180) / 360) * n);
      x <= clamp(((bounds.getEast() + 180) / 360) * n);
      x++
    )
      for (let y = clamp(row(bounds.getNorth())); y <= clamp(row(bounds.getSouth())); y++)
        tiles.push({ z, x, y });
    return tiles;
  }

  private url(frame: number, tile: { z: number; x: number; y: number }) {
    return tileTemplate("/api/tiles", this.manifest.dataset, this.manifest.frames[frame]!.id)
      .replace("{z}", String(tile.z))
      .replace("{x}", String(tile.x))
      .replace("{y}", String(tile.y));
  }

  private async load(url: string, signal: AbortSignal) {
    if (this.textures.has(url)) return;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Temperature tile unavailable (${response.status})`);
    const bytes = await decodeTile(await response.arrayBuffer());
    signal.throwIfAborted();
    const gl = this.gl;
    const texture = gl.createTexture()!;
    const activeUnit = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    gl.activeTexture(gl.TEXTURE0);
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
    const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, 256, 256, 0, gl.RG, gl.UNSIGNED_BYTE, bytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, previousTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.activeTexture(activeUnit);
    const existing = this.textures.get(url);
    if (existing) gl.deleteTexture(existing);
    this.textures.set(url, texture);
  }

  async show(milliseconds: number, onBuffer?: () => void): Promise<boolean> {
    const start = Date.parse(this.manifest.frames[0]!.time);
    const hour = (milliseconds - start) / 3_600_000;
    const a = Math.max(0, Math.min(this.manifest.frames.length - 1, Math.floor(hour)));
    let b = Math.min(a + 1, this.manifest.frames.length - 1);
    if (hour === a && this.manifest.frames[b]!.missing) b = a;
    this.missing = !!(this.manifest.frames[a]!.missing || this.manifest.frames[b]!.missing);
    if (this.missing) {
      this.controller.abort();
      this.generation++;
      this.pending = undefined;
      this.tiles = [];
      this.signature = "";
      this.map.triggerRepaint();
      return true;
    }
    const tiles = this.visible().map((tile) => ({
      ...tile,
      before: this.url(a, tile),
      after: this.url(b, tile),
    }));
    const signature = tiles.map((tile) => `${tile.before}:${tile.after}`).join("|");
    if (signature !== this.signature) {
      onBuffer?.();
      if (this.pending?.signature === signature) {
        await this.pending.promise;
      } else {
        this.controller.abort();
        this.controller = new AbortController();
        const signal = this.controller.signal;
        const generation = ++this.generation;
        const urls = [...new Set(tiles.flatMap((tile) => [tile.before, tile.after]))];
        const promise = (async () => {
          try {
            // Bounded network/decompression concurrency even when the entire world is visible.
            for (let i = 0; i < urls.length; i += 8)
              await Promise.all(urls.slice(i, i + 8).map((url) => this.load(url, signal)));
            if (generation !== this.generation) return false;
            this.tiles = tiles;
            this.signature = signature;
            const keep = new Set(urls);
            for (const [url, texture] of this.textures) {
              if (this.textures.size <= 192) break;
              if (!keep.has(url)) {
                this.gl.deleteTexture(texture);
                this.textures.delete(url);
              }
            }
            return true;
          } catch (error) {
            if (signal.aborted) return false;
            throw error;
          }
        })();
        this.pending = { signature, promise };
        await promise;
      }
    }
    if (this.signature !== signature) return false;
    this.fraction = a === b ? 0 : Math.max(0, Math.min(1, hour - a));
    this.map.triggerRepaint();
    return true;
  }

  render(_context: WebGLRenderingContext | WebGL2RenderingContext, input: CustomRenderMethodInput) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.program, "matrix"),
      false,
      input.defaultProjectionData.mainMatrix,
    );
    gl.uniform1f(gl.getUniformLocation(this.program, "fraction"), this.fraction);
    gl.uniform2f(gl.getUniformLocation(this.program, "range"), ...this.manifest.colorRange);
    gl.uniform1i(gl.getUniformLocation(this.program, "before"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "after"), 1);
    for (const tile of this.tiles) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.get(tile.before)!);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.get(tile.after)!);
      gl.uniform3f(gl.getUniformLocation(this.program, "tile"), tile.x, tile.y, 2 ** tile.z);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  onRemove() {
    this.controller.abort();
    for (const texture of this.textures.values()) this.gl.deleteTexture(texture);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }
}
