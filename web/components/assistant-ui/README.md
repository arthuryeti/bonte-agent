The chat components in `elements/` come from the official assistant-ui registry:
https://r.assistant-ui.com/thread.json and https://r.assistant-ui.com/thread-list.json.

Installed with shadcn. They use `@assistant-ui/react` and `@assistant-ui/react-markdown`.
The thread-list menu is omitted because the gateway only supports creating, listing,
and switching conversations. Edit/regenerate controls respect runtime capabilities;
the gateway owns a linear, persisted conversation. The application supplies gateway and attachment adapters
in `app/assistant-adapter.ts`; no assistant-ui cloud service is required.

Uploads need no category selection. The agent reads documents, classifies supporting
evidence for contract workflows, and asks focused questions in chat for missing or
ambiguous information. Authentication remains an application control. CRM results use
assistant-ui data renderers in `components/crm-results.tsx`, with tables and detail
panels fetched from the authenticated `/api/crm` route. Email drafts render as Markdown,
including download/mail links.

Workflow suggestions use assistant-ui's suggestion controls: six common starting
points and an expandable full list, also available in existing conversations.
Choosing one adds a guided prompt to the composer, preserving text and attachments
until the user sends it.
