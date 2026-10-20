# TG Search API shapes (from contracts)

## ProjectInput

```json
{
  "name": "string",
  "task": "clients | partners | investors | jobs | ads",
  "target": "who to find",
  "offer": "what you offer",
  "criteria": "Jev rule in Russian: inclusion/exclusion for messages",
  "geo": ["RU"],
  "languages": ["ru"],
  "accountIds": [1],
  "materials": [{ "kind": "file|url", "value": "path or url", "text": "optional extracted text" }],
  "keywords": ["phrase for Telegram search"],
  "sequence": [SequenceStep],
  "manager": ManagerSettings
}
```

## SequenceStep

```json
{ "delayHours": 24, "mode": "template|ai", "text": "message or AI instruction; {name} {request}" }
```

## ManagerSettings

```json
{
  "enabled": false,
  "baseUrl": "",
  "apiKey": "",
  "model": "",
  "prompt": "persona and rules in Russian",
  "replyDelaySec": 60,
  "maxReplies": 8
}
```

## AutopilotSettings (patch via autopilot.set)

```json
{
  "enabled": false,
  "refreshSources": false,
  "scanIntervalMin": 60,
  "freshnessHours": 24,
  "workingListSize": 10,
  "aiReply": false,
  "replyTarget": "dm|chat",
  "replyInNewSources": false,
  "joinIfNeeded": false,
  "minScore": 80,
  "lastRunAt": null,
  "nextRunAt": null
}
```

## BroadcastInput

```json
{
  "name": "string",
  "text": "offer text",
  "accountIds": [1],
  "chatLinks": ["@channel or https://t.me/..."],
  "intervalHours": 24,
  "spin": true
}
```

## LeadFilter (leads.list second arg)

```json
{ "status": "new|replied|dialog|hidden|all", "minScore": 70, "search": "substring" }
```
