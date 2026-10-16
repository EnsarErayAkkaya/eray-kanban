# Task #{{id}}: {{title}}
{{#description}}

{{description}}
{{/description}}
{{#acceptanceCriteria}}

## Acceptance criteria
{{acceptanceCriteria}}
{{/acceptanceCriteria}}

## Rules
- Don't run git commands that change history. Git is handled for you after review.
- If the task is ambiguous in a way that changes the result, stop and ask instead of guessing.

## Finish
End your final message with exactly one fenced json block, either:
```json
{"outcome": "done", "summary": "what you changed and why", "notes": [], "concerns": []}
```
or, if you need an answer before you can continue:
```json
{"outcome": "needs_input", "question": "one specific question"}
```
