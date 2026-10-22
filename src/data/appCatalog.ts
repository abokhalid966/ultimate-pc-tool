// The Fresh-install toolkit's app list. Edit freely: each entry needs a winget id (exactly as
// `winget search` shows it, including upper and lower case), a name, a one-line description
// and a category. Keep this file free of imports so dev/apps.test.ts can check it.
//
// - `source`: "msstore" for apps that only come from the Microsoft Store (the id is then the
//   Store's product id). Defaults to "winget".
// - `match`: recognizes the app in the installed-programs list, so it is marked as installed even
//   on PCs where winget isn't available yet.
// - `note`: shown under the description, e.g. a known limitation.

export const CATALOG_CATEGORIES = ["Browsers", "Communication", "Media", "Productivity", "Developer", "Utilities", "Gaming", "Security"] as const;

export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export interface CatalogApp {
  id: string;
  name: string;
  description: string;
  category: CatalogCategory;
  source?: "winget" | "msstore";
  match?: RegExp;
  note?: string;
}

export const CATALOG: CatalogApp[] = [
  // ---- Browsers ----
  { id: "Google.Chrome", name: "Google Chrome", description: "Fast, popular web browser from Google.", category: "Browsers", match: /^Google Chrome$/i },
  { id: "Mozilla.Firefox", name: "Firefox", description: "Private, independent browser from Mozilla.", category: "Browsers", match: /^Mozilla Firefox\b/i },
  { id: "Brave.Brave", name: "Brave", description: "Browser that blocks ads and trackers by default.", category: "Browsers", match: /^Brave\b/i },
  { id: "Opera.Opera", name: "Opera", description: "Browser with a built-in free VPN and ad blocker.", category: "Browsers", match: /^Opera Stable\b/i },
  { id: "Vivaldi.Vivaldi", name: "Vivaldi", description: "Highly customizable browser with tab stacking.", category: "Browsers", match: /^Vivaldi\b/i },

  // ---- Communication ----
  { id: "Discord.Discord", name: "Discord", description: "Voice, video and text chat for friends and communities.", category: "Communication", match: /^Discord$/i },
  { id: "Zoom.Zoom", name: "Zoom", description: "Video meetings and calls.", category: "Communication", match: /^Zoom( Workplace)?\b/i },
  { id: "SlackTechnologies.Slack", name: "Slack", description: "Team chat and channels for work.", category: "Communication", match: /^Slack\b/i },
  { id: "Telegram.TelegramDesktop", name: "Telegram", description: "Fast messaging that syncs across devices.", category: "Communication", match: /^Telegram Desktop\b/i },
  { id: "OpenWhisperSystems.Signal", name: "Signal", description: "Private, end-to-end encrypted messaging.", category: "Communication", match: /^Signal\b/i },
  { id: "9NKSQGP7F2NH", name: "WhatsApp", description: "Chat and call your WhatsApp contacts from your PC.", category: "Communication", source: "msstore", match: /^WhatsApp\b/i },

  // ---- Media ----
  { id: "VideoLAN.VLC", name: "VLC media player", description: "Plays almost any video or music file.", category: "Media", match: /^VLC media player\b/i },
  {
    id: "Spotify.Spotify",
    name: "Spotify",
    description: "Music and podcasts streaming.",
    category: "Media",
    match: /^Spotify\b/i,
    note: "Spotify refuses to install while Ultimate PC Tool runs as administrator.",
  },
  { id: "OBSProject.OBSStudio", name: "OBS Studio", description: "Record your screen or stream live.", category: "Media", match: /^OBS Studio\b/i },
  { id: "Audacity.Audacity", name: "Audacity", description: "Record and edit audio.", category: "Media", match: /^Audacity\b/i },
  { id: "dotPDN.PaintDotNet", name: "Paint.NET", description: "Easy photo and image editor.", category: "Media", match: /^paint\.net\b/i },
  { id: "HandBrake.HandBrake", name: "HandBrake", description: "Convert and shrink video files.", category: "Media", match: /^HandBrake\b/i },

  // ---- Productivity ----
  { id: "TheDocumentFoundation.LibreOffice", name: "LibreOffice", description: "Free office suite: documents, spreadsheets, slides.", category: "Productivity", match: /^LibreOffice\b/i },
  { id: "Adobe.Acrobat.Reader.64-bit", name: "Adobe Acrobat Reader", description: "View, sign and comment on PDF files.", category: "Productivity", match: /^Adobe Acrobat\b/i },
  { id: "SumatraPDF.SumatraPDF", name: "Sumatra PDF", description: "Tiny, fast reader for PDFs and e-books.", category: "Productivity", match: /^SumatraPDF\b/i },
  { id: "Notion.Notion", name: "Notion", description: "Notes, docs and to-do lists in one place.", category: "Productivity", match: /^Notion\b/i },
  { id: "Obsidian.Obsidian", name: "Obsidian", description: "Private notes stored as files on your PC.", category: "Productivity", match: /^Obsidian\b/i },
  { id: "Dropbox.Dropbox", name: "Dropbox", description: "Keep files in sync and share them.", category: "Productivity", match: /^Dropbox\b/i },

  // ---- Developer ----
  { id: "Microsoft.VisualStudioCode", name: "Visual Studio Code", description: "Popular free code editor.", category: "Developer", match: /^Microsoft Visual Studio Code\b/i },
  { id: "Git.Git", name: "Git", description: "Version control for code projects.", category: "Developer", match: /^Git\b/ },
  { id: "Python.Python.3.13", name: "Python 3.13", description: "The Python programming language.", category: "Developer", match: /^Python 3\.13\.\d+/i },
  { id: "OpenJS.NodeJS.LTS", name: "Node.js LTS", description: "JavaScript runtime, long-term support version.", category: "Developer", match: /^Node\.js\b/i },
  { id: "Notepad++.Notepad++", name: "Notepad++", description: "Lightweight text and code editor.", category: "Developer", match: /^Notepad\+\+/i },
  { id: "Microsoft.WindowsTerminal", name: "Windows Terminal", description: "Modern tabbed terminal from Microsoft.", category: "Developer" },

  // ---- Utilities ----
  { id: "7zip.7zip", name: "7-Zip", description: "Open and create zip, 7z and rar archives.", category: "Utilities", match: /^7-Zip\b/i },
  { id: "Microsoft.PowerToys", name: "PowerToys", description: "Handy extras for Windows from Microsoft.", category: "Utilities", match: /^PowerToys\b/i },
  { id: "voidtools.Everything", name: "Everything", description: "Finds any file on your PC instantly.", category: "Utilities", match: /^Everything\b/i },
  { id: "ShareX.ShareX", name: "ShareX", description: "Screenshots and screen recordings with editing.", category: "Utilities", match: /^ShareX\b/i },
  { id: "WinDirStat.WinDirStat", name: "WinDirStat", description: "See what's taking up space on your drives.", category: "Utilities", match: /^WinDirStat\b/i },
  { id: "AnyDesk.AnyDesk", name: "AnyDesk", description: "Remote help: control another PC or get help on yours.", category: "Utilities", match: /^AnyDesk\b/i },
  { id: "CrystalDewWorld.CrystalDiskInfo", name: "CrystalDiskInfo", description: "Checks the health of your drives.", category: "Utilities", match: /^CrystalDiskInfo\b/i },

  // ---- Gaming ----
  { id: "Valve.Steam", name: "Steam", description: "The biggest PC game store and launcher.", category: "Gaming", match: /^Steam$/i },
  { id: "EpicGames.EpicGamesLauncher", name: "Epic Games Launcher", description: "Epic's game store, with free games every week.", category: "Gaming", match: /^Epic Games Launcher\b/i },
  { id: "GOG.Galaxy", name: "GOG Galaxy", description: "DRM-free games and one library for all launchers.", category: "Gaming", match: /^GOG GALAXY\b/i },
  { id: "ElectronicArts.EADesktop", name: "EA app", description: "Play and buy EA games.", category: "Gaming", match: /^EA app\b/i },

  // ---- Security ----
  { id: "Malwarebytes.Malwarebytes", name: "Malwarebytes", description: "Finds and removes malware. Works alongside Windows Security.", category: "Security", match: /^Malwarebytes\b/i },
  { id: "Bitwarden.Bitwarden", name: "Bitwarden", description: "Free password manager that syncs everywhere.", category: "Security", match: /^Bitwarden\b/i },
  { id: "KeePassXCTeam.KeePassXC", name: "KeePassXC", description: "Offline password manager.", category: "Security", match: /^KeePassXC\b/i },
  { id: "Proton.ProtonVPN", name: "Proton VPN", description: "VPN with a free plan and no ads.", category: "Security", match: /^Proton VPN\b/i },
];
