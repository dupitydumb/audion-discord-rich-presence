# Discord Rich Presence

**Show what you're listening to on Discord!**

This plugin integrates Audion with Discord Rich Presence, allowing you to display your current playback status, track details, and album art directly in your Discord profile.

> **Note:** This plugin requires Discord to be installed and running on your desktop. Rich Presence is only supported on desktop platforms.

## Features

- **Real-time Status**: Updates your Discord status instantly when you play, pause, or change tracks.
- **Cover Art**: Automatically fetches and displays album art from multiple sources — Local files, Tidal, Qobuz, Saavn, and many more.
- **Cover Priority**: Configurable priority system to choose which cover source wins when multiple are available.
- **Time Elapsed/Remaining**: Shows a progress bar or time elapsed in your status.
- **Customizable Details**: Choose what to display on each line (Track Title, Artist, Album, or Custom Text).
- **Activity Timeout**: Optionally clear your presence after a period of inactivity.
- **Pause Icon**: Display a "(Paused)" indicator on album art when playback is paused.

## Installation

1. Open Audion.
2. Go to **Settings > Plugins**.
3. Click **Open Folder > Plugins**.
4. Download or clone this plugin into the `plugins` directory.
   - Folder name should be `discord-rich-presence`.
5. Restart Audion
6. Enable the plugin in the settings menu.

## Usage

Once enabled, the plugin will automatically connect to your local Discord client.

- **Play Music**: Start playing any track in Audion.
- **Check Discord**: Look at your own profile to see the rich presence in action.

## Configuration

You can customize the plugin via the settings panel:

- **Click the "Discord Rich Presence" button** in the player bar (Discord icon) or access it via the Plugins settings.

### Cover Art

- **Use Local Covers**: Uploads your local album art to catbox.moe so Discord can display it. This plugin is not affiliated with catbox.moe.
- **Use Online Covers**: Fetches album art from installed cover provider plugins (e.g. Tidal, Qobuz, Saavn). These plugins must be installed separately.
- **Cover Priority**: Controls which cover source is preferred. Enter source IDs separated by `/` in order of preference — e.g. `jiosaavn/qobuz/local/tidal`.
- **Refresh Cover Art**: Clears the cached cover for the current track and re-fetches it.

### Display Options

- **Show Progress Bar**: Display playback progress in Discord.
- **Show Pause Icon**: Display "(Paused)" on album art when paused.

### Activity Timeout

- **Clear When Paused**: Auto-clear presence after inactivity.
- **Timeout Duration**: Set how long to wait before clearing (1–30 minutes).

### Update Frequency

- **Throttle Interval**: Normal playback updates throttled to this interval (10–30 seconds). Song changes, pauses, and seeks update immediately.

### Display Format

- **Status Display**: Controls which field appears in your Discord status text (member list).
- **App Name / Details / State**: Each line supports compound formatting with left and right fields separated by a dot (e.g. Track Title • Artist).

## Permissions

This plugin requires the following permissions:

- `player:read` — To get current track info.
- `ui:inject` — To add the settings button to the UI.
- `storage:local` — To save your configuration preferences.
- `network:fetch` — To upload local cover art and fetch covers from online providers.
