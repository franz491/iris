# Iris frontend — components

- **LeftBar** — chat list (rename/delete per chat), "+ new chat", "+ AI"
  card creation, gear button opening SettingsModal.
- **ChatView** — message list (MessageItem), LiveReply streaming indicator,
  composer with a cursor-driven @mention whisper picker (shows while the caret sits inside an @token), "load older messages"
  button with scroll anchoring (bottom-stick only when near bottom),
  attachment picker and clipboard-image paste/upload, guest-chat banner with
  context deletion.
- **MessageItem** — avatar/identicon, author, time, whisper labels, hover
  edit/truncate controls, collapsible "thought" section, image/file rendering,
  and amber collapsible "Tool use" blocks for tool call/result rows showing
  success/failure with arguments + result JSON.
- **RightBar** — AI cards, participant list (+add member/AI forms), tool
  settings button, chat settings checkboxes (user/AI interruptions,
  "Force AI to reply"), "clear all messages" (confirm; wipes history +
  compaction state server-side).
- **BottomPanel** — hosts TopTools etc.; interactive terminal panel is a
  planned addition (see roadmap).
- **ToolSettingsModal** — per-chat tool groups: "load tool documentation into
  the context" checkbox (? tooltip explains lazy vs forced doc loading),
  tri-state off/on/ask approval select, expandable rows with tool docs +
  function docs, frontend-doc editing (machine-local), export/import of
  {kind:"iris.toolconfig"} JSON, "use as defaults".
- **SettingsModal** — backend URL override (persisted localStorage
  iris.backendUrl; save reloads the app). Defaults from
  VITE_IRIS_BACKEND_URL.
- **ToolApprovalModal** — asks the user to approve/deny tool requests
  (timeout policy from the tool setting).
- **EditCardModal / NewAiCardModal** — AI persona cards (name/model/prompt,
  pfp upload with identicon fallback).
