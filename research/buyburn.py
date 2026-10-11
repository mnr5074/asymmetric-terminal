#!/usr/bin/env python3
"""Wrapper: buyback/burn research lives in research/buyburn/. Usage: python research/buyburn.py [revenue|burns|analyze|all]
Uses research/buyburn/.venv (numpy/pandas/scipy). Outputs in research/buyburn/data/ and data/buyburn_projections.json."""
import os, subprocess, sys
H = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'buyburn')
py = os.path.join(H, '.venv', 'bin', 'python'); py = py if os.path.exists(py) else sys.executable
st = sys.argv[1] if len(sys.argv) > 1 else 'all'
if st in ('revenue', 'all'): subprocess.check_call([py, 'buyburn.py', 'revenue'], cwd=H)
if st in ('burns', 'all'): subprocess.check_call([py, 'buyburn.py', 'burns'], cwd=H)
if st in ('analyze', 'all'):
    subprocess.check_call([py, 'buyburn_analysis.py'], cwd=H); subprocess.check_call([py, 'make_tables.py'], cwd=H)
