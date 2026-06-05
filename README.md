# Orbit 🌍

A beautiful, progressive web app for tracking progress on your goals and habits. Built with vanilla HTML, CSS, and JavaScript—no frameworks, no bloat.

## 📋 Overview

Orbit is a **goal and habit tracker** designed for simplicity and offline-first functionality. Create items, organize them by category, set progress targets, and watch your completion percentage grow. Perfect for fitness goals, study objectives, project milestones, and daily habits.

### Key Features

- **📊 Progress Tracking**: Set targets and track completion with real-time percentage calculations
- **📅 Flexible Scheduling**: Track items by date ranges, specific days of the week, or custom date lists
- **🎯 Smart Status**: Automatically categorize items as *On Track*, *Behind*, *Overdue*, or *Done*
- **🔔 Notifications**: Set reminders at configurable times (6am–9pm)
- **📱 Offline-First PWA**: Works offline with Service Worker support, installable on mobile
- **🌓 Dark/Light Mode**: Automatic theme switching based on system preferences
- **💾 Gist Sync**: Backup and sync your data across devices using GitHub Gist
- **🎨 Custom Categories**: Organize items with color-coded categories
- **📈 Visual Progress Bars**: See at a glance how close you are to completion
- **⌛ Flip Cards**: Click any card to see detailed stats and adjust progress

## 🚀 Getting Started

### Prerequisites
- A modern web browser (Chrome, Firefox, Safari, Edge)
- Git (for cloning)
- Optional: GitHub Personal Access Token (for Gist sync)

### Installation

1. **Clone the repository:**
```bash
git clone https://github.com/HelloSamar/Orbit.git
cd Orbit
```

2. **Serve locally** (choose one):

**Python 3:**
```bash
python -m http.server 8000
```

**Node.js (http-server):**
```bash
npx http-server
```

**Node.js (simple alternative):**
```bash
node -e "require('http').createServer((q,s)=>require('fs').createReadStream('index.html').pipe(s)).listen(8000)"
```

3. **Open in browser:**
```
http://localhost:8000
```

## 🌐 Live Demo

View the live version on GitHub Pages:  
**https://hellosamar.github.io/Orbit/**

## 💡 How to Use

### Creating an Item

1. Click the **+ (add)** button in the bottom-right
2. Go to the **Add** tab
3. Fill in:
   - **Title**: Name your goal (e.g., "Read 50 pages")
   - **Category**: Pick a color-coded category
   - **Target**: Number to reach (e.g., 50 pages)
   - **Unit**: What you're counting (e.g., "pages")
   - **Schedule**: Choose date range, specific weekdays, or custom dates
4. Click **Save**

### Tracking Progress

- **Front of card**: See title, percentage, and progress bar
- **Click the card**: Flip to see detailed stats
- **±1 buttons**: Adjust progress up or down
- **Close**: Click ✕ to flip back

### Managing Categories

Go to the **Categories** tab to:
- Create custom categories with any color
- Edit existing categories
- Delete categories (with confirmation)

### Setting Reminders

1. Open the **Reminders** section
2. Click time slots (6am, 9am, 12pm, 3pm, 6pm, 9pm) to toggle
3. Allow notifications when prompted
4. Reminders work even when the app is closed (on Android/Windows 11)

### Syncing with GitHub Gist

In **Settings**:
1. Create a [GitHub Gist](https://gist.github.com) (any content)
2. Copy your [Personal Access Token](https://github.com/settings/tokens) (needs `gist` scope)
3. Enter Gist ID and token
4. **Push** to backup data → **Pull** to restore

## 📁 Project Structure

```
Orbit/
├── index.html          # Main app (all-in-one file)
├── style.css           # Styling (embedded)
├── sw.js              # Service Worker (offline support)
├── manifest.json      # PWA manifest
├── icon-192.png       # App icon (small)
├── icon-512.png       # App icon (large)
├── apple-touch-icon.png # iOS home screen icon
└── README.md          # This file
```

## 🎨 Customization

### Change Colors

Edit the CSS variables in `index.html` (search for `:root`):

```css
:root {
  --bg: #f0f2f8;        /* Background */
  --text: #141620;      /* Text color */
  --blue: #3a5ff0;      /* Primary accent */
  --green: #12a454;     /* On-track status */
  --red: #e02a47;       /* Overdue status */
  --amber: #d97706;     /* Behind status */
}
```

### Modify Suggested Categories

Look for `SUGGESTED_CATS` in the JavaScript section to customize default options.

## 🔧 Technical Details

### Data Storage

- **localStorage**: All items, categories, and settings (key: `orbit_v3`)
- **Structured data format**:
  ```json
  {
    "items": [{ "id", "title", "category", "target", "completed", "unit", "start", "end", "scheduleType", "scheduleDays", "scheduleDates" }],
    "categories": [{ "id", "name", "color" }],
    "reminders": ["6am", "12pm", "9pm"]
  }
  ```

### Status Calculation

Items automatically get assigned a status based on progress vs. expected progress:

- **Done**: `completed >= target`
- **On Track**: Making expected progress
- **Behind**: Lagging behind expected progress
- **Overdue**: Past the end date with incomplete target
- **Pending**: Not yet started

### Service Worker

- Caches app assets for offline access
- Handles push notifications
- Background sync for reminders

## 🤝 Contributing

Contributions welcome! To improve Orbit:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make changes and test locally
4. Commit: `git commit -m "Add your feature"`
5. Push: `git push origin feature/your-feature`
6. Submit a Pull Request

## 📄 License

This project is open source and available for personal and educational use.

## 🐛 Known Limitations

- Single-file structure means no build step, but larger HTML file
- Service Worker support varies by browser (works on all modern browsers)
- Gist sync requires manual token entry (no OAuth flow)

## 🚀 Future Ideas

- Export data to CSV/JSON
- Recurring item templates
- Collaborative tracking
- Mobile app (React Native/Flutter version)
- Calendar view
- Detailed analytics and charts

## 👤 Author

Created by [HelloSamar](https://github.com/HelloSamar)

---

**Last Updated**: June 2, 2026  
**Status**: Active Development
