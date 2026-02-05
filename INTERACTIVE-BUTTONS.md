# OpenClaw Interactive Slack Buttons

## Overview

Both VIP email notifications and batch email summaries now include interactive buttons that let you act on emails directly from Slack without opening your browser.

## Features

### Available Actions

Each email in Slack (whether VIP or batch summary) includes these buttons:

1. **📧 View** - View full email content in an ephemeral message (only you can see it)
2. **🌐 Gmail** - Open email in Gmail (browser)
3. **✓ Archive** - Archive the email (removes from inbox)
4. **🗑️ Delete** - Move email to trash
5. **🚫 Unsubscribe** - Run automated unsubscribe

### How It Works

#### Architecture

```
┌─────────────────────┐
│  Gmail Monitor      │
│  Sends Block Kit    │
│  messages with      │
│  action buttons     │
└──────────┬──────────┘
           │
           v
┌─────────────────────┐
│  Slack (Socket Mode)│
│  User clicks button │
└──────────┬──────────┘
           │
           v
┌─────────────────────┐
│ Slack Events Monitor│
│ Handles interactive │
│ event via WebSocket │
└──────────┬──────────┘
           │
           v
┌─────────────────────┐
│  Action Handlers    │
│  - View: Gmail API  │
│  - Archive: gog CLI │
│  - Delete: gog CLI  │
│  - Unsubscribe: CLI │
└─────────────────────┘
```

#### Components

1. **gmail-monitor.js**
   - Creates Block Kit messages with action buttons
   - `createUrgentEmailBlocks()` for VIP notifications
   - `sendBatchSummary()` for batch summaries

2. **slack-events-monitor.js**
   - Handles Socket Mode interactive events
   - `handleInteractive()` routes button clicks to actions
   - `sendEmailContent()` displays full email via ephemeral message
   - Action handlers for archive, delete, unsubscribe

#### Key Technical Decisions

**Socket Mode vs HTTP Webhooks**
- Using Socket Mode (WebSocket) - no need for ngrok or public URLs
- Events arrive in real-time via existing WebSocket connection

**Ephemeral Messages vs Modals**
- Switched from modals to ephemeral messages
- Reason: Slack's `trigger_id` expires in 3 seconds, but Gmail API takes 5+ seconds
- Ephemeral messages don't need `trigger_id` and have no timeout

**User ID vs Username**
- Ephemeral messages require `user.id`, not `user.username`
- Fixed: `await sendEmailContent(channel, payload.user.id, emailId)`

## Testing

### Test VIP Notification
```bash
cd ~/.openclaw/workspace
./test-vip-notification
```

### Test Batch Summary
```bash
cd ~/.openclaw/workspace
./test-batch-summary
```

Both scripts:
1. Find real unread emails in your inbox
2. Send test notifications with interactive buttons
3. Use real email IDs so buttons actually work

## Configuration

All configuration is in the monitor files:

```javascript
const CONFIG = {
  slackToken: 'xoxb-...',           // Slack bot token
  slackAppToken: 'xapp-...',        // Slack app token (Socket Mode)
  mySlackUserId: 'U...',            // Your Slack user ID
  gmailAccount: 'your@email.com'    // Gmail account for gog CLI
};
```

## Troubleshooting

### Button clicks do nothing
- Check that `slack-events-monitor.js` is running
- Look for errors in `/tmp/slack-events.log`
- Verify Socket Mode is enabled in Slack app settings

### "Expired trigger_id" error
- This was the modal approach - we switched to ephemeral messages
- Should not occur with current implementation

### "Invalid arguments" error
- Check that we're using `payload.user.id` not `payload.user.username`
- Ephemeral messages require the user ID

### Duplicate processes
- If you see duplicate monitors running: `pkill -f gmail-monitor`
- Restart cleanly: `cd ~/.openclaw/workspace && node gmail-monitor.js &`

## Future Enhancements

Potential improvements:
- **Reply button** - Quick reply to emails from Slack
- **Forward button** - Forward email to someone
- **Snooze button** - Snooze email for later (return to inbox)
- **Mark as read** - Mark email as read without archiving
- **Labels** - Quick label application (e.g., "Follow-up", "Important")
- **Batch actions** - "Archive All" button on batch summaries

## Files

- `gmail-monitor.js` - Creates Block Kit messages with buttons
- `slack-events-monitor.js` - Handles button interactions
- `test-vip-notification` - Test script for VIP notifications
- `test-batch-summary` - Test script for batch summaries
- `INTERACTIVE-BUTTONS.md` - This documentation
