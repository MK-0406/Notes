# LumiNote 📝

A powerful, feature-rich digital note-taking application inspired by GoodNotes. Built with vanilla JavaScript, HTML, and CSS - no frameworks required.

## ✨ Features

### Drawing & Writing
- **Smooth Pen Tool** with pressure-sensitive curves using Quadratic Bezier rendering
- **Realistic Highlighter** with multiply blend mode for authentic transparency
- **Smart Eraser** with two modes:
  - Standard: Erase by area
  - Stroke Eraser: Remove entire strokes
- **Shape Recognition** - Hold still after drawing to auto-straighten circles, squares, and lines
- **Laser Pointer** - Ephemeral red trail for presentations (fades after 800ms)

### Text & Images
- **Rich Text Support** - Click to add text anywhere on the canvas
- **Image Insertion** - Add images with drag-to-resize
- **Recent Images Reel** - Quick access to previously used images

### Selection & Editing
- **Lasso Tool** with context menu:
  - Cut, Copy, Paste, Duplicate, Delete
  - Persistent clipboard (survives page refresh)
  - Resize selected content with drag handle
- **Tap Selection** - Single tap to select individual strokes or elements

### Multi-Page Support
- **Unlimited Pages** - Add as many pages as you need
- **Page Templates**:
  - Plain (blank)
  - Dotted grid
  - Lined grid
- **Smooth Scrolling** - Natural vertical page navigation
- **Per-Page Undo/Redo** - Independent history for each page

### Advanced Features
- **Zoom & Pan** - Ctrl+Scroll to zoom (0.5x - 3.0x), Pan tool for navigation
- **Sepia Mode** - Night-shift style warm tint to reduce eye strain
- **Palm Guard** - Prevents accidental touches at screen bottom
- **Auto-Save** - All notes saved to localStorage automatically
- **PWA Support** - Install as a standalone app on any device

## 🚀 Getting Started

### Online Demo
Simply open `index.html` in any modern web browser.

### Local Installation
1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/luminote.git
   cd luminote
   ```

2. Open `index.html` in your browser, or serve with a local server:
   ```bash
   # Python 3
   python -m http.server 8000
   
   # Node.js
   npx serve
   ```

3. Visit `http://localhost:8000`

### Install as PWA
1. Open the app in Chrome/Edge/Safari
2. Click the install icon in the address bar
3. Enjoy offline access!

## 🎨 Usage

### Basic Drawing
1. Select a tool from the toolbar (Pen, Highlighter, Eraser)
2. Choose your color and size
3. Draw on the canvas

### Working with Pages
- **Add Page**: Click the ➕ button in the header
- **Change Template**: Use the dropdown next to the add button
- **Navigate**: Scroll naturally or use the zoom tool

### Selection & Editing
1. Switch to Lasso tool (➰)
2. Circle content or tap to select
3. Use the context menu to Cut/Copy/Paste/Duplicate/Delete
4. Drag the resize handle to scale selections

### Keyboard Shortcuts
- **Undo**: Ctrl+Z (or use Undo button)
- **Redo**: Ctrl+Shift+Z (or use Redo button)
- **Zoom**: Ctrl+Scroll

## 🛠️ Technology Stack

- **Pure Vanilla JavaScript** - No frameworks, maximum performance
- **HTML5 Canvas** - High-performance drawing
- **CSS3** - Modern, responsive design
- **LocalStorage API** - Persistent data storage
- **Service Workers** - Offline functionality
- **Progressive Web App** - Installable on any device

## 📱 Browser Support

- ✅ Chrome/Edge 90+
- ✅ Safari 14+
- ✅ Firefox 88+
- ✅ Mobile browsers (iOS Safari, Chrome Mobile)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT License - feel free to use this project for personal or commercial purposes.

## 🙏 Acknowledgments

Inspired by GoodNotes and other premium note-taking applications.

---

**Made with ❤️ by [Your Name]**
