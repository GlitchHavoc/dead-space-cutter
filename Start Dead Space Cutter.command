#!/bin/zsh
cd -- "$(dirname "$0")" || exit 1
echo "Dead Space Cutter is running."
echo "Opening dashboard: http://127.0.0.1:8877"
echo "Drop videos into: $PWD/Drop Videos Here"
echo "Finished videos will appear in: $PWD/edited"
echo
python3 ./dead-space-cutter-server.py
