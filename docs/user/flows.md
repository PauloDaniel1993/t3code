# Flows

Flows live in `.t3code/flow/<id>.json` in your project. Prompts can reference inputs and earlier step outputs, for example `{{inputs.issue}}` or `{{steps.review.output.text}}`. Lists render as bullet lists. Missing values, including skipped steps and previous outputs in the first loop iteration, render as empty text.

Write `\{{literal}}` in a prompt to display `{{literal}}` without treating it as a reference (in JSON, escape the backslash as `\\`). Command lines are literal and cannot contain `{{`. Put references in the command step's `env` values instead, then read the variables with your shell's syntax. Lists in environment variables are joined with newlines.
