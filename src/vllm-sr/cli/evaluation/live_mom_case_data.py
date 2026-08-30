"""Immutable rows for the built-in Mixture-of-Models campaign cohort."""

from __future__ import annotations

from cli.evaluation.live_mom_case_data_part1 import LIVE_MOM_CASE_ROWS_PART_1
from cli.evaluation.live_mom_case_data_part2 import LIVE_MOM_CASE_ROWS_PART_2

LIVE_MOM_CASE_ROWS = (*LIVE_MOM_CASE_ROWS_PART_1, *LIVE_MOM_CASE_ROWS_PART_2)
