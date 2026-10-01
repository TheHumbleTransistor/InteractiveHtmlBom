#!/usr/bin/env bash
# Build the demo iBOM, with the 3D view, from this checkout.
#
#   demo/build.sh [output.html]
#
# Needs kicad-cli on PATH and a python that can `import pcbnew` ($PYTHON, default
# /usr/bin/python3 when present).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"
out="$(realpath -m "${1:-$here/out/ibom-demo.html}")"
python="${PYTHON:-$( [ -x /usr/bin/python3 ] && echo /usr/bin/python3 || echo python3 )}"
board="$here/demo.kicad_pcb"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

kicad-cli pcb export glb --subst-models --include-tracks --include-pads --include-silkscreen \
  --include-soldermask -o "$tmp/demo.glb" "$board"

INTERACTIVE_HTML_BOM_NO_DISPLAY=1 PYTHONPATH="$repo" "$python" \
  -m InteractiveHtmlBom.generate_interactive_bom "$board" \
  --glb "$tmp/demo.glb" \
  --extra-data-file "$board" \
  --dest-dir "$tmp" --name-format ibom-demo --no-browser \
  --show-fields "Value,Footprint,Manufacturer,MPN,kicad_dnp" \
  --group-fields "Value,Footprint" \
  --checkboxes "Sourced,Placed" \
  --include-tracks --include-nets

mkdir -p "$(dirname "$out")"
mv "$tmp/ibom-demo.html" "$out"
echo "demo: $out"
