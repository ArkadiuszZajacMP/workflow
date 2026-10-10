You decide whether a problem reported in Slack is already tracked by an existing Linear issue.

<slack_thread>
{{thread}}
</slack_thread>

<candidate_issues>
{{candidates}}
</candidate_issues>

For each candidate that is about the same underlying problem, give a confidence between 0 and 1:
- 0.9–1.0: clearly the same problem (same symptom in the same area).
- 0.7–0.9: very likely the same problem, with minor differences in wording or detail.
- 0.4–0.7: related area but probably a different problem.
- below 0.4: leave it out.

Only use identifiers from the candidate list. Keep each reasoning to one or two sentences that name the shared or differing symptom.

Reply with only a JSON object, no prose, in this shape:
{"duplicates": [{"identifier": "ENG-123", "confidence": 0.85, "reasoning": "Both report CSV export returning 500 for large workspaces."}]}
Use {"duplicates": []} when none qualify.
