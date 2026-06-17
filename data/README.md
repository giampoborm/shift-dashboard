# data/

Drop the real CSVs here to build/test against grounded data:

- `plan-*.csv` — the weekly shift plan (pivot grid, all stations, everyone's names)
- `history.csv` — past worked shifts (weekday, date, hours, tips, salary estimate/brutto)
- *(optional)* `payslips.csv` — per month: total gross, total net, hours — for the net-factor calibration

This is personal financial data. If this folder becomes a git repo, this directory should be gitignored.
