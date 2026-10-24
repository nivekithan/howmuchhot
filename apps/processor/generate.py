"""Render real Dynamical GFS analysis tiles to a local directory (optional debugging CLI)."""
import argparse
from pathlib import Path
from grid import render_tile
from weather import prepare, write_manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-zoom", type=int, default=3)
    parser.add_argument("--end-time", help="UTC analysis timestamp; default: latest available")
    args = parser.parse_args()
    manifest, grids = prepare(args.max_zoom, args.end_time)
    count = 0
    for frame in manifest["frames"]:
        for z in range(manifest["maxZoom"] + 1):
            for x in range(2**z):
                for y in range(2**z):
                    path = args.output / manifest["dataset"] / frame["id"] / str(z) / str(x) / f"{y}.png"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(render_tile(grids[frame["id"]], z, x, y, manifest["maxZoom"]))
                    count += 1
        print(f"Rendered {frame['id']} ({frame['time']})", flush=True)
    dataset_path = args.output / manifest["dataset"] / "manifest.json"
    write_manifest(dataset_path, manifest)
    # Never replace the active pointer until every tile has been generated successfully.
    write_manifest(args.output / "manifest.json", manifest)
    print(f"Published {count} real Dynamical GFS tiles in {args.output}; latest analysis {manifest['latestTime']}", flush=True)


if __name__ == "__main__":
    main()
