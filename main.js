class LumiNote {
    constructor() {
        this.container = document.querySelector('.canvas-wrapper');
        this.ctx = null; // Current context for drawing operations
        this.activeCanvas = null; // Canvas currently being interacted with

        // App State
        this.isDrawing = false;
        this.isLassoing = false;
        this.isMoving = false;
        this.isResizing = false;
        this.tool = 'pen';

        // Multi-Tool Presets
        this.presets = {
            pen: { sizes: [2, 4, 6], activeIndex: 0, color: '#000000' },
            highlighter: { sizes: [15, 25, 40], activeIndex: 0, color: '#ffeb3b' },
            eraser: { sizes: [15, 30, 50], activeIndex: 1, color: 'eraser' },
            shape: { sizes: [2, 4, 6], activeIndex: 0, color: '#000000' },
            text: { sizes: [2, 4, 6], activeIndex: 0, color: '#000000' }
        };

        this.lineWidth = this.presets.pen.sizes[0];
        this.color = this.presets.pen.color;
        this.opacity = 1.0;

        this.eraseEntireStroke = true;
        this.hasChanged = false; // For history optimization
        this.recentImages = []; // Track recent images for the reel

        // Data Structures
        this.pages = [{ strokes: [], template: 'plain' }];
        this.currentPageIndex = 0;
        this.currentStroke = null;
        this.lassoPath = null;
        this.selectedStrokes = [];
        this.moveStart = null;

        // History: Store actions { pageIndex: number, type: 'modify'|'add'|'remove', data: JSON string of page strokes }
        // Simplest robust undo: Snapshot the specific page content.
        this.undoStack = [];
        this.redoStack = [];
        this.holdStartTime = 0;

        this.palmGuardY = window.innerHeight - 100;

        this.init();
        this.palmGuardY = window.innerHeight - 100;

        // New features state
        this.viewport = { scale: 1 };
        this.laserTrail = []; // {x, y, time}

        this.init();
        this.setupPalmGuard();
        this.setupZoomHandlers(); // New handlers
        this.render();
    }

    init() {
        this.loadNotes();
        this.initializeVisuals();
        this.setupScrollObserver();
        this.setupPages(); // Initial page DOM creation
        this.setupEventListeners(); // Must be after pages are created to attach to window/document or re-attach
    }

    setupScrollObserver() {
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const idx = parseInt(entry.target.dataset.pageIndex);
                if (!isNaN(idx) && this.pages[idx]) {
                    this.pages[idx].isVisible = entry.isIntersecting;
                }
            });

            // Update current page indicator based on max visibility
            const visible = entries.filter(e => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
            if (visible.length > 0) {
                const idx = parseInt(visible[0].target.dataset.pageIndex);
                if (!isNaN(idx)) {
                    this.currentPageIndex = idx;
                    this.updatePageIndicator();
                }
            }
        }, { threshold: [0.01, 0.1, 0.5, 0.9] });
    }

    setupPages() {
        // Sync DOM with this.pages
        const dpr = window.devicePixelRatio || 1;
        const w = 841, h = 1189; // A4

        // Clear existing if any
        const existing = Array.from(this.container.querySelectorAll('.note-canvas'));

        // Remove extras
        if (existing.length > this.pages.length) {
            for (let i = this.pages.length; i < existing.length; i++) {
                if (this.observer) this.observer.unobserve(existing[i]);
                existing[i].remove();
            }
        }

        // Add/Update
        this.pages.forEach((page, i) => {
            let canvas = existing[i];
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.className = 'note-canvas';
                canvas.dataset.pageIndex = i;
                this.attachCanvasEvents(canvas);
                this.container.appendChild(canvas);
                if (this.observer) this.observer.observe(canvas);
            }

            if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
                canvas.width = w * dpr;
                canvas.height = h * dpr;
                canvas.style.width = w + 'px';
                canvas.style.height = h + 'px';
            }
        });
    }

    attachCanvasEvents(canvas) {
        canvas.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
        canvas.addEventListener('pointermove', (e) => this.handlePointerMove(e));
        canvas.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    }

    setupZoomHandlers() {
        const scrollContainer = this.container.parentElement; // .scroll-container

        // Wheel Zoom (Ctrl + Wheel)
        scrollContainer.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                this.setZoom(this.viewport.scale * delta);
            }
        }, { passive: false });
    }

    setZoom(newScale) {
        this.viewport.scale = Math.max(0.5, Math.min(3.0, newScale));
        this.container.style.transformOrigin = 'top center';
        this.container.style.transform = `scale(${this.viewport.scale})`;

        // Force redraw or just rely on CSS?
        // CSS transform makes it blurry.
        // For Pro quality, we might need to re-render.
        // But re-rendering requires changing canvas dimensions which resets context.
        // Let's stick to CSS for performant "viewing" zoom.
    }

    initializeVisuals() {
        ['pen', 'highlighter', 'eraser'].forEach(tool => {
            const container = document.querySelector(`.size-slots[data-tool-type="${tool}"]`);
            if (container) {
                const p = this.presets[tool];
                if (!p) return;
                container.querySelectorAll('.size-slot').forEach(slot => {
                    const idx = parseInt(slot.dataset.index);
                    if (p.sizes[idx] !== undefined) {
                        this.updateSlotVisual(slot, p.sizes[idx], tool);
                        slot.classList.toggle('active', idx === p.activeIndex);
                    }
                });
            }
        });
    }

    get currentPage() {
        return this.pages[this.currentPageIndex];
    }

    setupEventListeners() {
        // Global listeners
        window.addEventListener('resize', () => {
            this.setupPages();
            this.render();
        });

        window.addEventListener('pointerup', () => {
            if (this.isDrawing || this.isLassoing || this.isMoving) {
                this.handlePointerUp();
            }
        });

        // Tool Selection
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = btn.dataset.tool;
                const allowedTools = ['pen', 'highlighter', 'eraser', 'shape', 'text', 'lasso', 'zoom', 'image', 'laser'];
                if (!allowedTools.includes(tool)) return;

                const prevActive = document.querySelector('.tool-btn.active');
                if (prevActive) prevActive.classList.remove('active');
                btn.classList.add('active');
                this.tool = tool;

                // Stop any active interaction to prevent ghosts
                this.isDrawing = false;
                this.currentStroke = null;
                this.isLassoing = false;
                this.isMoving = false;
                this.lassoPath = null;

                // Sync with tool-specific state
                if (this.presets[tool]) {
                    const p = this.presets[tool];
                    this.lineWidth = p.sizes[p.activeIndex];
                    this.color = p.color;
                    this.opacity = tool === 'highlighter' ? 0.3 : 1.0;
                }

                document.getElementById('pen-settings').classList.toggle('hidden', tool !== 'pen');
                document.getElementById('highlighter-settings').classList.toggle('hidden', tool !== 'highlighter');
                document.getElementById('eraser-settings').classList.toggle('hidden', tool !== 'eraser');
                document.getElementById('image-settings').classList.toggle('hidden', tool !== 'image');

                // Hide all popovers and refresh UI
                document.querySelectorAll('.size-popover').forEach(p => p.classList.add('hidden'));
                this.initializeVisuals();
                if (tool === 'image') this.updateImageReel();
            });
        });

        // Color Selection
        document.querySelectorAll('.color-slot').forEach(slot => {
            slot.addEventListener('click', () => {
                const toolType = slot.closest('.setting-row').id.split('-')[0];
                const active = slot.parentElement.querySelector('.color-slot.active');
                if (active) active.classList.remove('active');
                slot.classList.add('active');

                const color = slot.dataset.color;
                this.color = color;
                if (this.presets[toolType]) this.presets[toolType].color = color;
            });
        });

        document.querySelectorAll('.custom-color-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const color = e.target.value;
                const toolType = input.closest('.setting-row').id.split('-')[0];
                this.color = color;
                if (this.presets[toolType]) this.presets[toolType].color = color;

                // Set the '+' button's background as feedback
                input.parentElement.style.background = color;
                input.parentElement.style.borderColor = 'transparent';
                input.parentElement.style.color = 'white';
            });
        });

        // Generalized Size Selection
        document.querySelectorAll('.size-slots').forEach(container => {
            const toolType = container.dataset.toolType;
            const popover = container.querySelector('.size-popover');
            const slider = container.querySelector('.size-adjust-slider');
            const display = container.querySelector('.size-value-display');

            container.querySelectorAll('.size-slot').forEach(slot => {
                slot.addEventListener('click', () => {
                    const idx = parseInt(slot.dataset.index);
                    const wasActive = slot.classList.contains('active');
                    const p = this.presets[toolType];

                    container.querySelector('.size-slot.active').classList.remove('active');
                    slot.classList.add('active');

                    p.activeIndex = idx;
                    this.lineWidth = p.sizes[idx];

                    if (wasActive) {
                        popover.classList.toggle('hidden');
                        if (!popover.classList.contains('hidden')) {
                            slider.value = this.lineWidth;
                            display.textContent = this.lineWidth + (toolType === 'pen' ? 'pt' : 'px');
                        }
                    } else {
                        popover.classList.add('hidden');
                    }
                });
            });

            slider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const p = this.presets[toolType];
                p.sizes[p.activeIndex] = val;
                this.lineWidth = val;
                display.textContent = val + (toolType === 'pen' ? 'pt' : 'px');

                // Update dot visual
                const activeSlot = container.querySelector('.size-slot.active');
                this.updateSlotVisual(activeSlot, val, toolType);
                this.savePresets();
            });
        });

        // Eraser Mode Toggle
        const btnStandard = document.getElementById('btn-erase-standard');
        const btnStroke = document.getElementById('btn-erase-stroke');

        if (btnStandard && btnStroke) {
            btnStandard.addEventListener('click', () => {
                this.eraseEntireStroke = false;
                btnStandard.classList.add('active');
                btnStroke.classList.remove('active');
            });

            btnStroke.addEventListener('click', () => {
                this.eraseEntireStroke = true;
                btnStroke.classList.add('active');
                btnStandard.classList.remove('active');
            });
        }

        // Interaction logic (History & Closing Popovers)
        document.addEventListener('mousedown', (e) => {
            if (!e.target.closest('.size-popover') && !e.target.classList.contains('size-slot')) {
                document.querySelectorAll('.size-popover').forEach(p => p.classList.add('hidden'));
            }
            // Close Lasso Menu if clicked outside
            const menu = document.getElementById('lasso-menu');
            if (menu && !menu.classList.contains('hidden') && !e.target.closest('#lasso-menu')) {
                menu.classList.add('hidden');
            }
        });

        // Undo / Redo
        document.getElementById('undo-btn').addEventListener('click', () => this.undo());
        document.getElementById('redo-btn').addEventListener('click', () => this.redo());

        // Sepia Toggle
        document.getElementById('sepia-toggle-btn').addEventListener('click', () => {
            document.body.classList.toggle('sepia-mode');
        });

        // Add Page
        document.getElementById('add-page-btn').addEventListener('click', () => {
            this.addPage();
            this.scrollToPage(this.currentPageIndex);
        });

        const templateSelect = document.getElementById('template-select');
        templateSelect.addEventListener('change', (e) => {
            this.currentPage.template = e.target.value;
            this.saveNotes();
        });

        // Image Tool Trigger
        const imageInput = document.getElementById('image-upload-input');
        imageInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            files.forEach(file => {
                const reader = new FileReader();
                reader.onload = (event) => {
                    const src = event.target.result;
                    this.addRecentImage(src);
                    // If it's the first image in a batch, maybe add it to canvas too?
                    // GoodNotes usually just adds to reel first.
                };
                reader.readAsDataURL(file);
            });
        });
    }

    addImageToCanvas(src, x = 150, y = 150) {
        const img = new Image();
        img.onload = () => {
            // Save state for undo BEFORE modifying
            this.pushUndo(this.currentPageIndex, JSON.stringify(this.currentPage.strokes));

            this.currentPage.strokes.push({
                type: 'image',
                src: src,
                x: x, y: y,
                w: 200, h: 200 * (img.height / img.width),
                points: []
            });
            this.addRecentImage(src);
            this.saveNotes();
        };
        img.src = src;
    }


    addRecentImage(src) {
        if (!this.recentImages.includes(src)) {
            this.recentImages.unshift(src);
            if (this.recentImages.length > 8) this.recentImages.pop();
            this.updateImageReel();
        }
    }

    updateImageReel() {
        const reel = document.getElementById('recent-images-reel');
        if (!reel) return;
        reel.querySelectorAll('.reel-item:not(.add-btn)').forEach(item => item.remove());

        this.recentImages.forEach(src => {
            const item = document.createElement('div');
            item.className = 'reel-item';
            item.innerHTML = `<img src="${src}">`;
            item.onclick = () => this.addImageToCanvas(src);
            reel.appendChild(item);
        });
    }

    // Image Cache to prevent flickering
    getImage(src) {
        if (!this.imageCache) this.imageCache = new Map();
        let img = this.imageCache.get(src);
        if (!img) {
            img = new Image();
            img.src = src;
            this.imageCache.set(src, img);
        }
        return img;
    }

    setupPalmGuard() {
        const guard = document.getElementById('palm-hide');
        if (!guard) return;
        const handle = guard.querySelector('.palm-drag-handle');
        if (!handle) return;

        let isDraggingGuard = false;

        handle.addEventListener('pointerdown', (e) => {
            isDraggingGuard = true;
            handle.setPointerCapture(e.pointerId);
        });

        window.addEventListener('pointermove', (e) => {
            if (isDraggingGuard) {
                this.palmGuardY = Math.max(100, Math.min(window.innerHeight - 50, e.clientY));
                guard.style.top = this.palmGuardY + 'px';
            }
        });

        window.addEventListener('pointerup', () => {
            isDraggingGuard = false;
        });

        // Initial position
        guard.style.top = this.palmGuardY + 'px';
    }

    scrollToPage(index) {
        const canvases = this.container.querySelectorAll('.note-canvas');
        if (canvases[index]) {
            canvases[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    addPage() {
        this.pages.push({ strokes: [], template: 'plain' });
        this.currentPageIndex = this.pages.length - 1;
        this.setupPages();
        this.saveNotes();
        this.updatePageIndicator();
    }

    changePage(delta) {
        const newIndex = this.currentPageIndex + delta;
        if (newIndex >= 0 && newIndex < this.pages.length) {
            this.currentPageIndex = newIndex;
            this.updatePageIndicator();
            const templateSelect = document.getElementById('template-select');
            if (templateSelect) templateSelect.value = this.currentPage.template || 'plain';
        }
    }

    recognizeAndStraightenShape() {
        if (!this.currentStroke || this.currentStroke.points.length < 5) return;
        const pts = this.currentStroke.points;
        const start = pts[0];
        const end = pts[pts.length - 1];

        const distStartEnd = Math.hypot(end.x - start.x, end.y - start.y);

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        pts.forEach(p => {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        });
        const width = maxX - minX;
        const height = maxY - minY;
        const centerX = minX + width / 2;
        const centerY = minY + height / 2;

        const idealRadius = (width + height) / 4;
        let circleVariance = 0;
        pts.forEach(p => {
            const d = Math.hypot(p.x - centerX, p.y - centerY);
            circleVariance += Math.abs(d - idealRadius);
        });
        circleVariance /= pts.length;

        if (circleVariance < idealRadius * 0.25) {
            const circlePts = [];
            for (let i = 0; i <= 60; i++) {
                const angle = (i / 60) * Math.PI * 2;
                circlePts.push({ x: centerX + Math.cos(angle) * idealRadius, y: centerY + Math.sin(angle) * idealRadius });
            }
            this.currentStroke.points = circlePts;
            this.currentStroke.isShape = true;
            return;
        }

        const isClosed = distStartEnd < Math.max(width, height) * 0.4;
        if (isClosed) {
            if (width / height > 0.6 && width / height < 1.4) {
                this.currentStroke.points = [
                    { x: minX, y: minY }, { x: maxX, y: minY },
                    { x: maxX, y: maxY }, { x: minX, y: maxY }, { x: minX, y: minY }
                ];
            } else {
                this.currentStroke.points = [
                    { x: centerX, y: minY }, { x: maxX, y: maxY },
                    { x: minX, y: maxY }, { x: centerX, y: minY }
                ];
            }
        } else {
            this.currentStroke.points = [start, end];
        }
    }

    handlePointerDown(e) {
        // Palm Guard Check
        if (e.clientY > this.palmGuardY) return;
        if (e.pointerType === 'touch' && (e.width > 20 || e.height > 20)) return;

        // Determine which page we are on
        const canvas = e.target.closest('.note-canvas');
        if (!canvas) return;

        this.activeCanvas = canvas;
        this.currentPageIndex = parseInt(canvas.dataset.pageIndex);
        this.updatePageIndicator();

        const coords = this.getCoordinates(e, canvas);
        this.holdStartTime = Date.now();
        this.lastMoveTime = Date.now();
        this.hasChanged = false;

        // Capture state of THIS page for undo
        this.preInteractionState = JSON.stringify(this.pages[this.currentPageIndex].strokes);

        if (this.tool === 'lasso') {
            const bounds = this.getSelectionBounds();
            if (bounds) {
                const handleX = bounds.x + bounds.w;
                const handleY = bounds.y + bounds.h;
                if (Math.hypot(coords.x - handleX, coords.y - handleY) < 15) {
                    this.isResizing = true;
                    this.moveStart = coords;
                    return;
                }
            }

            if (this.selectedStrokes.length === 1 && this.selectedStrokes[0].type === 'text') {
                const s = this.selectedStrokes[0];
                const hit = coords.x >= s.x && coords.x <= s.x + (s.w || 100) && coords.y >= s.y && coords.y <= s.y + (s.h || 30);
                if (hit) {
                    this.triggerTextEdit(s);
                    return;
                }
            }

            if (this.selectedStrokes.length > 0 && this.isPointInLasso(coords, this.lassoPath)) {
                this.isMoving = true;
                this.moveStart = coords;
            } else {
                this.isLassoing = true;
                this.lassoPath = [coords];
                this.selectedStrokes = [];
            }
        } else if (this.tool === 'text') {
            const hitText = this.currentPage.strokes.find(s =>
                s.type === 'text' &&
                coords.x >= s.x && coords.x <= s.x + (s.w || 100) &&
                coords.y >= s.y && coords.y <= s.y + (s.h || 30)
            );
            if (hitText) {
                this.triggerTextEdit(hitText);
            } else {
                this.createTextElement(coords);
            }
        } else if (this.tool === 'image') {
            return;
        } else if (this.tool === 'laser') {
            this.laserTrail = [{ x: coords.x, y: coords.y, time: Date.now() }];
            this.isDrawing = true; // Use drawing flag to track active laser session
        } else if (this.tool === 'zoom') {
            // Pan logic
            this.isMoving = true;
            this.moveStart = { x: e.clientX, y: e.clientY }; // Screen coords for panning
            this.scrollStart = { x: this.container.parentElement.scrollLeft, y: this.container.parentElement.scrollTop };
        } else {
            this.isDrawing = true;
            this.currentStroke = {
                points: [coords],
                color: this.tool === 'eraser' ? 'eraser' : this.color,
                width: this.lineWidth,
                opacity: this.tool === 'highlighter' ? 0.3 : 1.0,
                tool: this.tool
            };
        }
    }

    createTextElement(coords, initialText = '', initialSize = null) {
        // Use activeCanvas for positioning relative to
        if (!this.activeCanvas) return;
        const rect = this.activeCanvas.getBoundingClientRect();
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'canvas-text-input';
        // Use exact screen coordinates
        input.style.left = (rect.left + window.scrollX + coords.x) + 'px';
        input.style.top = (rect.top + window.scrollY + coords.y) + 'px';
        input.style.color = this.color;
        input.style.fontSize = (initialSize || (this.lineWidth * 4 + 12)) + 'px';
        input.value = initialText;
        document.body.appendChild(input);
        setTimeout(() => {
            input.focus();
            if (initialText) input.setSelectionRange(initialText.length, initialText.length);
        }, 10);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.finalizeText(input, coords);
            }
        });
        input.addEventListener('blur', () => {
            this.finalizeText(input, coords);
        });
    }

    triggerTextEdit(stroke) {
        this.currentPage.strokes = this.currentPage.strokes.filter(s => s !== stroke);
        this.selectedStrokes = [];
        this.lassoPath = null;
        this.render();
        this.createTextElement({ x: stroke.x, y: stroke.y }, stroke.text, stroke.size);
    }

    finalizeText(input, coords) {
        const val = input.value;
        if (val) {
            this.ctx.font = input.style.fontSize + " Inter, sans-serif";
            const metrics = this.ctx.measureText(val);
            const height = parseInt(input.style.fontSize);

            this.currentPage.strokes.push({
                type: 'text',
                text: val,
                x: coords.x,
                y: coords.y,
                w: metrics.width,
                h: height,
                color: input.style.color || this.color,
                size: height,
                points: []
            });
            this.saveNotes();
        }
        if (input.parentElement) input.remove();
    }

    handlePointerMove(e) {
        // Use active canvas if known, otherwise we might be dragging across (?) 
        // For drawing, we stick to one page usually.
        if (!this.activeCanvas) return;
        const coords = this.getCoordinates(e, this.activeCanvas);
        if (this.isDrawing) {
            if (this.tool === 'laser') {
                this.laserTrail.push({ x: coords.x, y: coords.y, time: Date.now() });
                return;
            }

            const lastPoint = this.currentStroke.points[this.currentStroke.points.length - 1];
            const dist = Math.hypot(coords.x - lastPoint.x, coords.y - lastPoint.y);

            this.currentStroke.points.push(coords);

            // Only reset the hold timer if the movement is significant (> 1px)
            // This filters out minor tremors/jitter while holding the pen still
            if (dist > 1) {
                this.lastMoveTime = Date.now();
            }

            if (this.tool === 'eraser') {
                this.performErase(this.currentStroke);
            }
        } else if (this.tool === 'laser' && this.isDrawing) {
            this.laserTrail.push({ x: coords.x, y: coords.y, time: Date.now() });
        } else if (this.tool === 'zoom' && this.isMoving) {
            const dx = e.clientX - this.moveStart.x;
            const dy = e.clientY - this.moveStart.y;
            this.container.parentElement.scrollLeft = this.scrollStart.x - dx;
            this.container.parentElement.scrollTop = this.scrollStart.y - dy;
        } else if (this.isLassoing) {
            this.lassoPath.push(coords);
        } else if (this.isMoving) {
            const dx = coords.x - this.moveStart.x;
            const dy = coords.y - this.moveStart.y;
            this.selectedStrokes.forEach(s => {
                if (s.type === 'text' || s.type === 'image') {
                    s.x += dx;
                    s.y += dy;
                } else {
                    s.points.forEach(p => { p.x += dx; p.y += dy; });
                }
            });
            if (this.lassoPath) this.lassoPath.forEach(p => { p.x += dx; p.y += dy; });
            this.moveStart = coords;
            this.hasChanged = true;
        } else if (this.isResizing) {
            const bounds = this.getSelectionBounds();
            if (!bounds || bounds.w === 0 || bounds.h === 0) return;

            const dx = (coords.x - this.moveStart.x);
            const dy = (coords.y - this.moveStart.y);
            // Ensure we don't divide by zero or invert too much
            const scaleX = (bounds.w + dx) > 0 ? (bounds.w + dx) / bounds.w : 0.1;
            const scaleY = (bounds.h + dy) > 0 ? (bounds.h + dy) / bounds.h : 0.1;
            // Uniform scaling for now as per previous logic (mostly)
            const scale = Math.max(0.1, (scaleX + scaleY) / 2);

            this.selectedStrokes.forEach(s => {
                if (s.type === 'text' || s.type === 'image') {
                    const rx = s.x - bounds.x;
                    const ry = s.y - bounds.y;
                    s.x = bounds.x + rx * scale;
                    s.y = bounds.y + ry * scale;
                    s.w = (s.w || 50) * scale;
                    s.h = (s.h || 20) * scale;
                    if (s.type === 'text') s.size = (s.size || 20) * scale;
                } else {
                    s.points.forEach(p => {
                        const rx = p.x - bounds.x;
                        const ry = p.y - bounds.y;
                        p.x = bounds.x + rx * scale;
                        p.y = bounds.y + ry * scale;
                    });
                }
            });
            if (this.lassoPath) {
                this.lassoPath.forEach(p => {
                    const rx = p.x - bounds.x;
                    const ry = p.y - bounds.y;
                    p.x = bounds.x + rx * scale;
                    p.y = bounds.y + ry * scale;
                });
            }
            this.moveStart = coords;
            this.hasChanged = true;
        }
    }

    handlePointerUp() {
        if (this.tool === 'laser') {
            this.isDrawing = false;
            // Trail fades out automatically in render
        }

        if (this.isDrawing && this.tool !== 'laser') {
            // Shape straightening / Recognition - check if pen was HELD STILL for > 700ms
            const pauseDuration = Date.now() - this.lastMoveTime;
            if (this.tool === 'shape' || (this.tool !== 'eraser' && pauseDuration > 700)) {
                this.recognizeAndStraightenShape();
            }

            if (this.tool !== 'eraser') {
                this.currentPage.strokes.push(this.currentStroke);
                this.hasChanged = true;
            }
            this.currentStroke = null;
            this.isDrawing = false;
        } else if (this.isLassoing) {
            this.isLassoing = false;
            if (this.lassoPath.length > 5) {
                this.findSelectedStrokes();
                if (this.selectedStrokes.length > 0) {
                    // Show Menu
                    const bounds = this.getSelectionBounds();
                    // Convert canvas bounds to screen coordinates for the menu
                    const rect = this.activeCanvas.getBoundingClientRect();
                    // Get scale factor
                    const scaleX = rect.width / this.activeCanvas.offsetWidth;
                    const scaleY = rect.height / this.activeCanvas.offsetHeight;

                    const screenX = rect.left + bounds.x * scaleX + (bounds.w * scaleX) / 2;
                    const screenY = rect.top + bounds.y * scaleY;

                    this.showLassoMenu(screenX, screenY);
                }
            } else {
                this.tapSelect(this.lassoPath[0]);
                if (this.selectedStrokes.length > 0) {
                    // Same show menu logic
                    const bounds = this.getSelectionBounds();
                    const rect = this.activeCanvas.getBoundingClientRect();
                    const scaleX = rect.width / this.activeCanvas.offsetWidth;
                    const scaleY = rect.height / this.activeCanvas.offsetHeight;
                    const screenX = rect.left + bounds.x * scaleX + (bounds.w * scaleX) / 2;
                    const screenY = rect.top + bounds.y * scaleY;
                    this.showLassoMenu(screenX, screenY);
                }
            }
        } else if (this.isMoving) {
            this.isMoving = false;
        } else if (this.isResizing) {
            this.isResizing = false;
        }

        if (this.hasChanged) {
            this.pushUndo(this.currentPageIndex, this.preInteractionState);
            this.saveNotes();
        }
    }

    pushUndo(pageIndex, oldStrokesState) {
        this.undoStack.push({
            pageIndex: pageIndex,
            strokes: oldStrokesState
        });
        this.redoStack = [];
        if (this.undoStack.length > 50) this.undoStack.shift();
    }

    getCoordinates(e, canvas) {
        const c = canvas || this.activeCanvas;
        if (!c) return { x: 0, y: 0 };
        const rect = c.getBoundingClientRect(); // Visual dimensions (screen px) including CSS transform

        // We render with ctx.scale(dpr, dpr).
        // This means drawing at (10, 10) draws at 10px logical, which is 10*dpr physical.
        // So we need to return LOGICAL coordinates relative to the un-transformed element.

        // rect.width is Visual Width. 
        // c.offsetWidth is Logical Width (approx, if no transform).
        // Best approach: Map screen ratio to logical ratio.

        // Logical Width of the canvas is determined by its style (e.g., 841px).
        // We can parse it or trust offsetWidth if un-rotated.
        const logicalWidth = c.offsetWidth;
        const logicalHeight = c.offsetHeight;

        const scaleX = logicalWidth / rect.width;
        const scaleY = logicalHeight / rect.height;

        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }

    updateSlotVisual(slot, val, toolType) {
        if (!slot) return;
        let visualSize;
        if (toolType === 'pen') {
            visualSize = 4 + (val * 1.2);
        } else if (toolType === 'highlighter') {
            visualSize = 8 + (val * 0.4);
        } else { // eraser
            visualSize = 10 + (val * 0.3);
        }
        slot.style.width = visualSize + 'px';
        slot.style.height = visualSize + 'px';
    }

    undo() {
        if (this.undoStack.length === 0) return;

        const action = this.undoStack.pop();
        const pageIndex = action.pageIndex;
        const page = this.pages[pageIndex];

        // Push current state to redo
        this.redoStack.push({
            pageIndex: pageIndex,
            strokes: JSON.stringify(page.strokes)
        });

        // Apply undo
        page.strokes = JSON.parse(action.strokes);
        this.saveNotes(); // Save ALL notes (simple)

        // Ensure we are viewing the change if possible (optional UX)
        // this.scrollToPage(pageIndex);
    }

    redo() {
        if (this.redoStack.length === 0) return;

        const action = this.redoStack.pop();
        const pageIndex = action.pageIndex;
        const page = this.pages[pageIndex];

        // Push current state to undo
        this.undoStack.push({
            pageIndex: pageIndex,
            strokes: JSON.stringify(page.strokes)
        });

        // Apply redo
        page.strokes = JSON.parse(action.strokes);
        this.saveNotes();
    }

    findSelectedStrokes() {
        this.selectedStrokes = this.currentPage.strokes.filter(s => {
            if (s.type === 'text' || s.type === 'image') {
                const cx = s.x + (s.w || 50) / 2;
                const cy = s.y + (s.h || 20) / 2;
                return this.isPointInLasso({ x: cx, y: cy }, this.lassoPath);
            }
            if (!s.points) return false;
            return s.points.some(p => this.isPointInLasso(p, this.lassoPath));
        });
    }

    getSelectionBounds() {
        if (!this.selectedStrokes || this.selectedStrokes.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.selectedStrokes.forEach(s => {
            if (s.type === 'text' || s.type === 'image') {
                minX = Math.min(minX, s.x);
                minY = Math.min(minY, s.y);
                maxX = Math.max(maxX, s.x + (s.w || 50));
                maxY = Math.max(maxY, s.y + (s.h || 20));
            } else if (s.points && s.points.length > 0) {
                s.points.forEach(p => {
                    minX = Math.min(minX, p.x);
                    minY = Math.min(minY, p.y);
                    maxX = Math.max(maxX, p.x);
                    maxY = Math.max(maxY, p.y);
                });
            }
        });
        if (minX === Infinity) return null;
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    tapSelect(coords) {
        if (!coords) return;
        let found = null;
        for (let i = this.currentPage.strokes.length - 1; i >= 0; i--) {
            const s = this.currentPage.strokes[i];
            if (s.type === 'text' || s.type === 'image') {
                const w = s.w || (s.type === 'text' ? 100 : 50);
                const h = s.h || (s.type === 'text' ? 30 : 50);
                if (coords.x >= s.x && coords.x <= s.x + w && coords.y >= s.y && coords.y <= s.y + h) {
                    found = s; break;
                }
            } else if (s.points) {
                for (let j = 0; j < s.points.length - 1; j++) {
                    if (this.distToSegment(coords, s.points[j], s.points[j + 1]) < 15) {
                        found = s; break;
                    }
                }
                if (found) break;
            }
        }

        if (found) {
            this.selectedStrokes = [found];
            const b = this.getSelectionBounds();
            if (b) {
                this.lassoPath = [
                    { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
                    { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
                    { x: b.x, y: b.y }
                ];
            }
        } else {
            this.selectedStrokes = [];
            this.lassoPath = null;
        }
    }

    isPointInLasso(p, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
            if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }

    performErase(eraser) {
        const radius = this.lineWidth / 2;
        if (eraser.points.length < 2) return;

        const ep2 = eraser.points[eraser.points.length - 1]; // Current eraser point
        const ep1 = eraser.points[eraser.points.length - 2]; // Previous eraser point

        if (this.eraseEntireStroke) {
            const initialCount = this.currentPage.strokes.length;
            this.currentPage.strokes = this.currentPage.strokes.filter(stroke => {
                if (!stroke.points || stroke.points.length < 2) return true; // Keep text/images
                // Check every segment of the stroke against the eraser's movement segment
                for (let i = 0; i < stroke.points.length - 1; i++) {
                    const sp1 = stroke.points[i];
                    const sp2 = stroke.points[i + 1];
                    if (this.segmentsDistance(ep1, ep2, sp1, sp2) < radius) return false;
                }
                return true;
            });
            if (this.currentPage.strokes.length !== initialCount) this.hasChanged = true;
        } else {
            let changed = false;
            let resultStrokes = [];

            this.currentPage.strokes.forEach(stroke => {
                if (!stroke.points || stroke.points.length < 2) {
                    resultStrokes.push(stroke);
                    return;
                }
                let currentSubPoints = [stroke.points[0]];

                for (let i = 0; i < stroke.points.length - 1; i++) {
                    const sp1 = stroke.points[i];
                    const sp2 = stroke.points[i + 1];

                    if (this.segmentsDistance(ep1, ep2, sp1, sp2) < radius) {
                        // Intersection! Break the current sub-stroke
                        if (currentSubPoints.length > 1) {
                            resultStrokes.push({ ...stroke, points: currentSubPoints });
                        }
                        currentSubPoints = [sp2]; // Start fresh from the next point
                        changed = true;
                    } else {
                        currentSubPoints.push(sp2);
                    }
                }

                if (currentSubPoints.length > 1) {
                    resultStrokes.push({ ...stroke, points: currentSubPoints });
                }
            });

            if (changed) {
                this.currentPage.strokes = resultStrokes;
                this.hasChanged = true;
            }
        }
    }

    // Advanced: Shortest distance between two line segments (ep1-ep2) and (sp1-sp2)
    segmentsDistance(p1, p2, p3, p4) {
        // First check if points are within radius of segments (standard check)
        const d1 = this.distToSegment(p3, p1, p2);
        const d2 = this.distToSegment(p4, p1, p2);
        const d3 = this.distToSegment(p1, p3, p4);
        const d4 = this.distToSegment(p2, p3, p4);
        return Math.min(d1, d2, d3, d4);
    }

    // Helper: Distance from point p to line segment v-w
    distToSegment(p, v, w) {
        const l2 = Math.pow(v.x - w.x, 2) + Math.pow(v.y - w.y, 2);
        if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
    }

    render() {
        const dpr = window.devicePixelRatio || 1;
        const canvases = this.container.querySelectorAll('.note-canvas');

        this.pages.forEach((page, index) => {
            // Optimization: Skip rendering if not visible (set by Observer)
            // If isVisible is undefined (first run), we render.
            if (page.isVisible === false) return;

            const canvas = canvases[index];
            if (!canvas) return;

            const ctx = canvas.getContext('2d');

            // Set transform for High DPI
            // Reset transform before setting it to avoid compounding
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(dpr, dpr);

            // Clear
            ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

            // Setup context for drawing callbacks
            this.ctx = ctx; // Hacky but works since we are single threaded
            // We need to pass the page template maybe?

            if (page.template === 'dotted') this.drawDots(canvas.width / dpr, canvas.height / dpr);
            else if (page.template === 'grid') this.drawGrid(canvas.width / dpr, canvas.height / dpr);

            page.strokes.forEach(s => this.drawStroke(s));

            // Draw Current Stroke (only if we are on this page)
            if (this.currentPageIndex === index && this.currentStroke) {
                this.drawStroke(this.currentStroke);
                // Eraser Preview
                if (this.tool === 'eraser' && this.isDrawing && this.currentStroke && this.currentStroke.points.length > 0) {
                    const last = this.currentStroke.points[this.currentStroke.points.length - 1];
                    ctx.beginPath();
                    ctx.arc(last.x, last.y, this.lineWidth / 2, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(0, 122, 255, 0.1)';
                    ctx.strokeStyle = 'rgba(0, 122, 255, 0.3)';
                    ctx.lineWidth = 1;
                    ctx.fill();
                    ctx.stroke();
                }
            }

            // Draw Lasso Overlay (only if on this page)
            if (this.currentPageIndex === index && this.lassoPath) {
                ctx.beginPath();
                ctx.setLineDash([5, 5]);
                ctx.strokeStyle = '#007aff';
                ctx.lineWidth = 1;
                this.lassoPath.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
                ctx.stroke();
                ctx.setLineDash([]);
                if (!this.isLassoing) {
                    ctx.fillStyle = 'rgba(0, 122, 255, 0.05)';
                    ctx.fill();
                }
            }

            // Draw Selection Box (only if active page)
            if (this.currentPageIndex === index && this.selectedStrokes.length > 0) {
                const bounds = this.getSelectionBounds();
                if (bounds) {
                    ctx.strokeStyle = '#007aff';
                    ctx.setLineDash([5, 5]);
                    ctx.lineWidth = 1;
                    ctx.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
                    ctx.setLineDash([]);

                    // Draw Resize Handle (Bottom-Right)
                    ctx.fillStyle = '#ffffff';
                    ctx.strokeStyle = '#007aff';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(bounds.x + bounds.w, bounds.y + bounds.h, 6, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }
            }

            // Draw Laser Trail (if active on this page)
            if (this.currentPageIndex === index && this.laserTrail.length > 0) {
                const now = Date.now();
                // Filter old points
                this.laserTrail = this.laserTrail.filter(p => now - p.time < 800);

                if (this.laserTrail.length > 1) {
                    ctx.shadowBlur = 6;
                    ctx.shadowColor = '#ff3b30'; // iOS Red
                    ctx.strokeStyle = 'rgba(255, 59, 48, 0.6)'; // Semi-transparent red trail
                    ctx.lineWidth = 4;
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    ctx.globalCompositeOperation = 'source-over';

                    ctx.beginPath();
                    // Use quadratic curves for smooth laser too
                    ctx.moveTo(this.laserTrail[0].x, this.laserTrail[0].y);
                    for (let i = 1; i < this.laserTrail.length; i++) {
                        ctx.lineTo(this.laserTrail[i].x, this.laserTrail[i].y);
                    }
                    ctx.stroke();

                    // glowing tip
                    const last = this.laserTrail[this.laserTrail.length - 1];
                    ctx.beginPath();
                    ctx.arc(last.x, last.y, 5, 0, Math.PI * 2);
                    ctx.fillStyle = '#ff3b30';
                    ctx.fill();
                    ctx.shadowBlur = 0;
                }
            }
        });

        requestAnimationFrame(() => this.render());
    }



    showLassoMenu(x, y, isPasteMode = false) {
        let menu = document.getElementById('lasso-menu');
        const hasClipboard = !!this.clipboard;

        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'lasso-menu';
            document.body.appendChild(menu);
        }

        // Re-render menu content based on mode
        let html = '';
        if (isPasteMode) {
            html = `<button id="lasso-paste">Paste</button>`;
        } else {
            html = `
                <button id="lasso-cut">Cut</button>
                <button id="lasso-copy">Copy</button>
                <button id="lasso-duplicate">Duplicate</button>
                <button id="lasso-delete" style="color:red">Delete</button>
            `;
            if (hasClipboard) {
                html += `<div style="height:1px;background:#eee;margin:2px 0"></div><button id="lasso-paste">Paste</button>`;
            }
        }
        menu.innerHTML = html;

        // Attach Listeners
        const btnCut = menu.querySelector('#lasso-cut');
        if (btnCut) btnCut.onclick = () => {
            this.copySelection();
            this.deleteSelection();
            menu.classList.add('hidden');
        };

        const btnCopy = menu.querySelector('#lasso-copy');
        if (btnCopy) btnCopy.onclick = () => {
            this.copySelection();
            menu.classList.add('hidden');
        };

        const btnDuplicate = menu.querySelector('#lasso-duplicate');
        if (btnDuplicate) btnDuplicate.onclick = () => {
            this.duplicateSelection();
            menu.classList.add('hidden');
        };

        const btnDelete = menu.querySelector('#lasso-delete');
        if (btnDelete) btnDelete.onclick = () => {
            this.pushUndo(this.currentPageIndex, this.preInteractionState);
            this.deleteSelection();
            this.saveNotes();
            menu.classList.add('hidden');
        };

        const btnPaste = menu.querySelector('#lasso-paste');
        if (btnPaste) btnPaste.onclick = () => {
            this.pushUndo(this.currentPageIndex, this.preInteractionState);
            this.pasteSelection(x, y);
            this.saveNotes();
            menu.classList.add('hidden');
        };

        menu.classList.remove('hidden');
        const menuWidth = 120;
        if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 10;
        menu.style.left = x + 'px';
        menu.style.top = (y - (isPasteMode ? 20 : 50)) + 'px';
    }

    pasteSelection(screenX, screenY) {
        if (!this.clipboard) return;
        try {
            const pastedStrokes = JSON.parse(this.clipboard);
            if (!Array.isArray(pastedStrokes) || pastedStrokes.length === 0) return;

            // Calculate center of pasted strokes
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            pastedStrokes.forEach(s => {
                const points = s.points || (s.x !== undefined ? [{ x: s.x, y: s.y }, { x: s.x + (s.w || 0), y: s.y + (s.h || 0) }] : []);
                points.forEach(p => {
                    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
                    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
                });
            });
            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) / 2;

            const rect = this.activeCanvas.getBoundingClientRect();
            const scaleX = this.activeCanvas.offsetWidth / rect.width;
            const scaleY = this.activeCanvas.offsetHeight / rect.height;

            const targetX = (screenX - rect.left) * scaleX;
            const targetY = (screenY - rect.top) * scaleY;

            const offsetX = targetX - centerX;
            const offsetY = targetY - centerY;

            // Apply Offset and Clone
            // We need to deep clone or ensure we don't modify the clipboard if we paste again
            // JSON.parse already created a new object structure.

            pastedStrokes.forEach(s => {
                if (s.points) {
                    s.points.forEach(p => { p.x += offsetX; p.y += offsetY; });
                }
                if (s.x !== undefined) s.x += offsetX;
                if (s.y !== undefined) s.y += offsetY;
            });

            this.currentPage.strokes.push(...pastedStrokes);
            this.selectedStrokes = pastedStrokes;
            const b = this.getSelectionBounds();
            if (b) {
                this.lassoPath = [
                    { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
                    { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
                    { x: b.x, y: b.y }
                ];
            }
            this.render();
        } catch (e) { console.error("Paste error", e); }
    }

    deleteSelection() {
        this.currentPage.strokes = this.currentPage.strokes.filter(s => !this.selectedStrokes.includes(s));
        this.selectedStrokes = [];
        this.lassoPath = null;
        this.render();
    }

    duplicateSelection() {
        if (this.selectedStrokes.length === 0) return;

        // Save undo state
        const preState = JSON.stringify(this.currentPage.strokes);

        this.clipboard = JSON.stringify(this.selectedStrokes);
        // Paste at slightly offset location
        const bounds = this.getSelectionBounds();
        if (!bounds) return;

        const rect = this.activeCanvas.getBoundingClientRect();
        // Calculate center of selection
        const centerX = bounds.x + bounds.w / 2;
        const centerY = bounds.y + bounds.h / 2;

        // Target screen position: same as selection but offset by 20px
        const scaleX = rect.width / this.activeCanvas.offsetWidth;
        const scaleY = rect.height / this.activeCanvas.offsetHeight;

        const screenX = rect.left + (centerX + 20) * scaleX;
        const screenY = rect.top + (centerY + 20) * scaleY;

        this.pasteSelection(screenX, screenY);
        this.pushUndo(this.currentPageIndex, preState);
        this.saveNotes();
    }

    copySelection() {
        // Simple clipboard simulation
        this.clipboard = JSON.stringify(this.selectedStrokes);
        localStorage.setItem('luminote_v3_clipboard', this.clipboard);
        // Prompt user?
        const btn = document.querySelector('.tool-btn[data-tool="lasso"]');
        if (btn) {
            const originalText = btn.innerHTML;
            btn.innerHTML = '✅';
            setTimeout(() => btn.innerHTML = originalText, 1000);
        }
    }

    drawStroke(s) {
        if (s.type === 'text') {
            this.ctx.fillStyle = s.color;
            this.ctx.font = `${s.size}px Inter, sans-serif`;
            this.ctx.textBaseline = 'top';
            this.ctx.fillText(s.text, s.x, s.y);
            return;
        }
        if (s.type === 'image') {
            const img = this.getImage(s.src);
            if (img.complete) {
                this.ctx.drawImage(img, s.x, s.y, s.w, s.h);
            }
            return;
        }

        const points = s.points;
        const len = points.length;
        if (len < 1) return;

        // Setup Context
        this.ctx.beginPath();
        const isEraser = s.color === 'eraser';
        const isHighlighter = s.tool === 'highlighter' || (s.opacity && s.opacity < 1 && !isEraser);

        if (isEraser) {
            this.ctx.strokeStyle = '#ffffff';
            this.ctx.globalCompositeOperation = 'source-over';
        } else if (isHighlighter) {
            this.ctx.strokeStyle = s.color;
            this.ctx.globalCompositeOperation = 'multiply'; // Real highlighter effect
            // Fix for dark mode or black paper? Multiply makes it invisible on black.
            // But standard paper is white.
        } else {
            this.ctx.strokeStyle = s.color;
            this.ctx.globalCompositeOperation = 'source-over';
        }

        this.ctx.lineWidth = s.width;
        // Highlighter usually flat cap/round join or round/round
        this.ctx.lineCap = isHighlighter ? 'butt' : 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.globalAlpha = s.opacity;

        if (len === 1) {
            this.ctx.arc(points[0].x, points[0].y, s.width / 2, 0, Math.PI * 2);
            this.ctx.fill();
        } else {
            this.ctx.moveTo(points[0].x, points[0].y);

            if (len === 2) {
                this.ctx.lineTo(points[1].x, points[1].y);
            } else {
                let i;
                for (i = 1; i < len - 2; i++) {
                    const c = {
                        x: (points[i].x + points[i + 1].x) / 2,
                        y: (points[i].y + points[i + 1].y) / 2
                    };
                    this.ctx.quadraticCurveTo(points[i].x, points[i].y, c.x, c.y);
                }
                // For the last 2 points
                this.ctx.quadraticCurveTo(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y);
            }
            this.ctx.stroke();
        }

        // Reset Context
        this.ctx.globalAlpha = 1.0;
        this.ctx.globalCompositeOperation = 'source-over';
    }

    drawDots(w, h) {
        this.ctx.fillStyle = '#d2d2d7';
        for (let x = 20; x < w; x += 20)
            for (let y = 20; y < h; y += 20)
                this.ctx.fillRect(x, y, 0.5, 0.5);
    }

    drawGrid(w, h) {
        this.ctx.strokeStyle = '#e5e5e5';
        this.ctx.lineWidth = 0.5;
        this.ctx.beginPath();
        for (let x = 0; x < w; x += 40) {
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, h);
        }
        for (let y = 0; y < h; y += 40) {
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(w, y);
        }
        this.ctx.stroke();
    }

    /* Deleted resize() as it's now handled in setupPages() */
    _unused_resize() {
        // Placeholder to ensure deletion of old method if needed
    }

    saveNotes() {
        localStorage.setItem('luminote_v3_data', JSON.stringify(this.pages));
        localStorage.setItem('luminote_v3_recent_imgs', JSON.stringify(this.recentImages));
    }

    savePresets() {
        localStorage.setItem('luminote_v3_presets', JSON.stringify(this.presets));
    }

    loadNotes() {
        const data = localStorage.getItem('luminote_v3_data');
        if (data) {
            try {
                this.pages = JSON.parse(data);
            } catch (e) {
                console.error("Failed to parse notes", e);
            }
        }

        const recent = localStorage.getItem('luminote_v3_recent_imgs');
        if (recent) {
            try {
                this.recentImages = JSON.parse(recent);
            } catch (e) {
                console.error("Failed to parse recent images", e);
            }
        }

        const presets = localStorage.getItem('luminote_v3_presets');
        if (presets) {
            try {
                const parsed = JSON.parse(presets);
                if (parsed.pen && Array.isArray(parsed.pen.sizes)) {
                    this.presets = parsed;
                }
            } catch (e) {
                console.error("Failed to parse presets", e);
            }
        }

        const clipboard = localStorage.getItem('luminote_v3_clipboard');
        if (clipboard) {
            this.clipboard = clipboard;
        }

        // Final sync of tool state
        const current = this.presets[this.tool] || this.presets.pen;
        this.lineWidth = current.sizes[current.activeIndex] || 2;
        this.color = current.color || '#000000';

        this.updatePageIndicator();
    }

    updatePageIndicator() {
        const indicator = document.getElementById('page-indicator-text');
        if (indicator) {
            indicator.textContent = `Page ${this.currentPageIndex + 1} / ${this.pages.length}`;
        }
    }
}

window.addEventListener('load', () => new LumiNote());
