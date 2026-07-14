#!/bin/zsh
cd -- "$(dirname "$0")" || exit 1
echo "Dead Space Cutter is running."
echo "Drop videos into: $PWD/Drop Videos Here"
echo "Finished videos will appear in: $PWD/edited"
echo
python3 ./watch-and-cut.py
