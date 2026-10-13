---
description: Show Jira ticket status (read-only)
argument-hint: "[KEY]"
---
Show the status of ${1:-the Jira ticket for the current git branch}. Call jira_read with action "get" for that ticket and reply with exactly these lines and nothing else:

Key:
Summary:
Status:
Assignee:

If jira_read returns an error (for example no_ticket, ambiguous_key, config_invalid, or not_authenticated), reply with the error kind and message instead of guessing.
