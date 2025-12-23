// LumiStore: Simple IndexedDB Wrapper for Pro-Level Storage (Offline Tablet Support)
class LumiStore {
    constructor(dbName = 'LumiDatabase', storeName = 'LumiStore') {
        this.dbName = dbName;
        this.storeName = storeName;
        this.db = null;
    }

    async getDB() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(this.storeName);
            request.onsuccess = () => { this.db = request.result; resolve(this.db); };
            request.onerror = () => reject(request.error);
        });
    }

    async get(key) {
        const db = await this.getDB();
        return new Promise((resolve) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const request = tx.objectStore(this.storeName).get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
        });
    }

    async set(key, val) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).put(val, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async delete(key) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
}

class LumiNote {
    constructor() {
        this.container = document.querySelector('.canvas-wrapper');
        this.ctx = null;
        this.activeCanvas = null;

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
        this.hasChanged = false;
        this.recentImages = [];

        // Data Structures
        this.pages = [{ strokes: [], template: 'plain' }];
        this.currentPageIndex = 0;
        this.currentStroke = null;
        this.lassoPath = null;
        this.selectedStrokes = [];
        this.moveStart = null;

        this.undoStack = [];
        this.redoStack = [];
        this.holdStartTime = 0;

        this.palmGuardY = window.innerHeight - 100;

        this.viewport = { scale: 1.0 };
        this.activePointers = new Map(); // Track multi-touch for capacitive pens
        this.gestureMode = null; // 'draw' or 'nav'
        this.scrollStart = { x: 0, y: 0 };
        this.lastGestureDist = null;
        this.lastGestureCenter = null;

        this.laserTrail = [];
        this.dpr = 4.0;

        // Multi-Notebook & Folder State (v6.8)
        this.notebooks = [];
        this.activeNotebookId = null;
        this.openNotebookIds = [];
        this.currentFolderId = 'root';
        this.viewMode = 'grid';
        this.libraryCategory = 'all'; // 'all', 'recent', 'favorites'
        this.searchQuery = '';
        this.sortBy = 'date'; // 'date', 'name'
        this.movingItemId = null;
        this.selectedMenuId = null;


        console.log('🚀 LumiNote: Constructing App...');
        this.init();
    }

    async init() {
        console.log("LumiNote v6.8 (Folders & View Modes) Initializing...");
        this.store = new LumiStore();

        await this.loadLibraryIndex();
        await this.loadSharedData();

        if (this.openNotebookIds.length > 0) {
            const lastId = await this.store.get('last_active_id');
            const targetId = lastId && this.openNotebookIds.includes(lastId) ? lastId : this.openNotebookIds[0];
            await this.openNotebook(targetId);
        } else if (this.notebooks.length > 0) {
            await this.openNotebook(this.notebooks[0].id);
        } else {
            await this.createNotebook("Quick Notes");
        }

        this.setupPages();
        this.initializeVisuals();
        this.setupScrollObserver();
        this.setupPalmGuard();
        this.setupZoomHandlers();
        this.setupEventListeners();
        this.setupLibraryListeners();
        this.render();
    }

    getCoordinates(e, canvas) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        const clientY = e.clientY || (e.touches && e.touches[0].clientY);

        // Calculate coordinate relative to the canvas visual size
        const x = (clientX - rect.left) / (rect.width / 841);
        const y = (clientY - rect.top) / (rect.height / 1189);

        return { x, y };
    }

    setupScrollObserver() {
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const idx = parseInt(entry.target.dataset.pageIndex);
                if (!isNaN(idx) && this.pages[idx]) {
                    const wasVisible = this.pages[idx].isVisible;
                    this.pages[idx].isVisible = entry.isIntersecting;

                    // If a page becomes visible and background needs refresh, trigger render
                    if (!wasVisible && entry.isIntersecting) {
                        this.pages[idx].hasBgChanged = true;
                        this.render();
                    }
                }
            });

            // Update current page indicator based on max visibility
            const visibleEntries = [...entries].filter(e => e.isIntersecting);
            if (visibleEntries.length > 0) {
                const mostVisible = visibleEntries.reduce((prev, curr) =>
                    (curr.intersectionRatio > prev.intersectionRatio) ? curr : prev
                );
                const idx = parseInt(mostVisible.target.dataset.pageIndex);
                if (!isNaN(idx)) {
                    this.currentPageIndex = idx;
                    this.updatePageIndicator();
                }
            }
        }, { threshold: [0.01, 0.5, 0.9], rootMargin: '200px' });
    }

    setupPages() {
        this.dpr = 3.0; // Optimized for mobile memory stability while keeping retina sharpness
        const dpr = this.dpr;
        const scale = this.viewport.scale || 1.0;

        const baseW = 841;
        const baseH = 1189;

        const containers = Array.from(this.container.querySelectorAll('.page-container'));

        // Sync containers with pages
        if (containers.length > this.pages.length) {
            for (let i = this.pages.length; i < containers.length; i++) {
                if (this.observer) this.observer.unobserve(containers[i]);
                containers[i].remove();
            }
        }

        this.pages.forEach((page, i) => {
            let pContainer = containers[i];
            let bgCanvas, inkCanvas;

            if (!pContainer) {
                pContainer = document.createElement('div');
                pContainer.className = 'page-container';
                pContainer.dataset.pageIndex = i;

                // Background Layer (PDF)
                bgCanvas = document.createElement('canvas');
                bgCanvas.className = 'bg-canvas note-canvas';

                // Top Layer (Ink/Drawing) - This gets the events
                inkCanvas = document.createElement('canvas');
                inkCanvas.className = 'ink-canvas note-canvas';

                pContainer.appendChild(bgCanvas);
                pContainer.appendChild(inkCanvas);

                this.attachCanvasEvents(inkCanvas);
                this.container.appendChild(pContainer);
                if (this.observer) this.observer.observe(pContainer);
            } else {
                bgCanvas = pContainer.querySelector('.bg-canvas');
                inkCanvas = pContainer.querySelector('.ink-canvas');
            }

            // Ensure correct interactive stacking
            bgCanvas.style.pointerEvents = 'none';
            inkCanvas.style.pointerEvents = 'auto';

            const visualW = baseW * scale;
            const visualH = baseH * scale;

            pContainer.style.width = visualW + 'px';
            pContainer.style.height = visualH + 'px';

            [bgCanvas, inkCanvas].forEach(c => {
                c.width = baseW * dpr;
                c.height = baseH * dpr;
                c.style.width = '100%';
                c.style.height = '100%';
                if (c === bgCanvas) {
                    c.style.imageRendering = '-webkit-optimize-contrast';
                    page.hasBgChanged = true; // RESIZE FIX: Resizing clears canvas, so we must redraw background
                }
                c.style.transform = 'translateZ(0)';
            });
        });
    }

    attachCanvasEvents(canvas) {
        canvas.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
        canvas.addEventListener('pointermove', (e) => this.handlePointerMove(e));
        canvas.addEventListener('pointerup', (e) => this.handlePointerUp(e));
        canvas.addEventListener('pointercancel', (e) => this.handlePointerUp(e));
    }

    setupZoomHandlers() {
        const scrollContainer = this.container.parentElement;

        // Wheel Zoom (Ctrl + Wheel)
        scrollContainer.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                // Reduce sensitivity for smoother control
                const delta = e.deltaY > 0 ? 0.95 : 1.05;
                this.setZoom(this.viewport.scale * delta);
            }
        }, { passive: false });
    }

    setZoom(newScale) {
        // Safe limit: Max 3.0x to prevent mobile browser canvas allocation failures
        const target = Math.max(0.4, Math.min(3.0, newScale));
        if (this.viewport.scale === target) return;

        this.viewport.scale = target;

        // SHARPNESS FIX: Remove container scaling, and instead update individual canvas CSS sizes
        // this.container.style.transform = 'none'; // No longer needed, scaling is per-canvas
        // this.container.style.transformOrigin = 'unset'; // No longer needed
        // this.container.style.width = '100%'; // No longer needed

        this.setupPages();
        this.render();

        console.log(`Zoom set to ${Math.round(this.viewport.scale * 100)}% (Native High-Res)`);
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

    updateSlotVisual(slot, size, tool) {
        if (!slot) return;
        // Tool-specific sizing for the preview dot
        let dotSize = size;
        if (tool === 'highlighter') dotSize = size * 0.5;
        if (tool === 'eraser') dotSize = size * 0.4;

        slot.style.setProperty('--dot-size', Math.max(2, Math.min(24, dotSize)) + 'px');

        // If it's the eraser, we might want a different visual (white with border)
        if (tool === 'eraser') {
            slot.style.backgroundColor = 'white';
            slot.style.border = '1px solid #d2d2d7';
        } else {
            slot.style.backgroundColor = this.presets[tool]?.color || '#000000';
            slot.style.border = 'none';
        }
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
                const row = input.closest('.setting-row');
                const toolType = row.id.split('-')[0];

                // Find the currently active slot in this row to "change existing color"
                const activeSlot = row.querySelector('.color-slot.active');
                if (activeSlot) {
                    activeSlot.dataset.color = color;
                    activeSlot.style.background = color;
                }

                this.color = color;
                if (this.presets[toolType]) this.presets[toolType].color = color;

                // Sync the Edit button visual too
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
        document.addEventListener('pointerdown', (e) => {
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

        // Pages Overview (v9.1 Fixed)
        const pagesOverviewBtn = document.getElementById('pages-overview-btn');
        if (pagesOverviewBtn) {
            pagesOverviewBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('📑 Button Clicked (v9.1)');
                this.openPagesOverview();
            };
        } else {
            console.error('❌ Pages Overview Button Not Found');
        }

        const templateSelect = document.getElementById('template-select');
        templateSelect.addEventListener('change', (e) => {
            this.currentPage.template = e.target.value;
            this.currentPage.hasBgChanged = true; // Mark background for re-render
            this.saveNotes();
            this.render(); // Request a re-render to show new template
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

        // PDF Import
        const libPdfBtn = document.getElementById('import-pdf-library-btn');
        const pdfInput = document.getElementById('pdf-upload-input');

        if (libPdfBtn && pdfInput) {
            libPdfBtn.onclick = (e) => {
                e.preventDefault();
                pdfInput.click();
            };
        }

        if (pdfInput) {
            pdfInput.onchange = async (e) => {
                const files = e.target.files;
                if (!files || files.length === 0) return;

                console.log(`📁 Import triggered for ${files.length} PDF(s)`);
                await this.importPDF(files);

                // Refresh visuals
                this.pages.forEach(p => p.hasBgChanged = true);
                this.render();
                pdfInput.value = ''; // Reset for next import
            };
        }
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
        const containers = this.container.querySelectorAll('.page-container');
        if (containers[index]) {
            containers[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    addPage() {
        this.pages.push({ strokes: [], template: 'plain', hasBgChanged: true }); // New page needs background render
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
        if (!this.currentStroke || this.currentStroke.points.length < 10) return;
        const pts = this.currentStroke.points;
        const first = pts[0];
        const last = pts[pts.length - 1];

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        pts.forEach(p => {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        });

        const w = maxX - minX;
        const h = maxY - minY;
        const centerX = minX + w / 2;
        const centerY = minY + h / 2;
        const distStartEnd = Math.hypot(last.x - first.x, last.y - first.y);

        // More lenient closure check for boxes/triangles
        const isClosed = distStartEnd < Math.max(w, h) * 0.5 || distStartEnd < 60;

        // 1. Check for Circle / Oval (Ellipse)
        const rx = w / 2;
        const ry = h / 2;
        let ellipseVariance = 0;
        pts.forEach(p => {
            const dx = (p.x - centerX) / (rx || 1);
            const dy = (p.y - centerY) / (ry || 1);
            ellipseVariance += Math.abs(Math.sqrt(dx * dx + dy * dy) - 1);
        });
        ellipseVariance /= pts.length;

        if (ellipseVariance < 0.12) {
            const circlePts = [];
            const steps = 72;
            const sizeDiff = Math.abs(w - h);
            const isCircle = sizeDiff < Math.max(w, h) * 0.2;

            let finalRx = rx;
            let finalRy = ry;

            if (isCircle) {
                const avgR = (rx + ry) / 2;
                finalRx = avgR;
                finalRy = avgR;
            }

            for (let i = 0; i <= steps; i++) {
                const angle = (i / steps) * Math.PI * 2;
                circlePts.push({ x: centerX + Math.cos(angle) * finalRx, y: centerY + Math.sin(angle) * finalRy });
            }
            this.currentStroke.points = circlePts;
            this.currentStroke.isShape = true;
            return;
        }

        // 2. Polygonal Shapes
        if (isClosed) {
            // Check if it's more like a Rectangle or a Triangle
            // We use the area of the stroke vs the area of the bounding box
            let strokeArea = 0;
            for (let i = 0; i < pts.length - 1; i++) {
                strokeArea += (pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y);
            }
            strokeArea = Math.abs(strokeArea) / 2;
            const boxArea = w * h;
            const ratio = strokeArea / (boxArea || 1);

            // Quadrilaterals usually occupy > 80% of their bounding box
            // Triangles occupy ~50%. We set the split at 0.7 for safety.
            if (ratio > 0.7) {
                // SQUARE / RECTANGLE
                const isSquare = Math.abs(w - h) < Math.max(w, h) * 0.15;
                const side = Math.max(w, h);
                const finalW = isSquare ? side : w;
                const finalH = isSquare ? side : h;
                const finalX = centerX - finalW / 2;
                const finalY = centerY - finalH / 2;

                this.currentStroke.points = [
                    { x: finalX, y: finalY }, { x: finalX + finalW, y: finalY },
                    { x: finalX + finalW, y: finalY + finalH }, { x: finalX, y: finalY + finalH },
                    { x: finalX, y: finalY }
                ];
            } else {
                // TRIANGLE (Iso-ish)
                this.currentStroke.points = [
                    { x: centerX, y: minY }, { x: maxX, y: maxY },
                    { x: minX, y: maxY }, { x: centerX, y: minY }
                ];
            }
            this.currentStroke.isShape = true;
        } else {
            // STRAIGHT LINE
            this.currentStroke.points = [first, last];
            this.currentStroke.isShape = true;
        }
    }

    handlePointerDown(e) {
        // Track pointer for multi-touch
        this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // Navigation Mode Switch: 2+ fingers = Scroll/Zoom, 1 finger = Write
        if (this.activePointers.size >= 2) {
            this.gestureMode = 'nav';
            if (this.isDrawing) {
                this.isDrawing = false;
                this.currentStroke = null; // Cancel accidental mark
            }
            this.scrollStart = {
                x: this.container.parentElement.scrollLeft,
                y: this.container.parentElement.scrollTop
            };
            this.lastGestureDist = this.getGestureDist();
            this.lastGestureCenter = this.getGestureCenter();
            this.render();
            return;
        }

        if (this.activePointers.size === 1) {
            this.gestureMode = 'draw';
        }

        // Palm Guard Check
        if (e.clientY > this.palmGuardY) return;

        // Determine which page we are on
        const canvas = e.target.closest('.ink-canvas'); // Only interact with the ink canvas
        if (!canvas) return;

        this.activeCanvas = canvas;
        this.currentPageIndex = parseInt(canvas.closest('.page-container').dataset.pageIndex);
        this.updatePageIndicator();

        const coords = this.getCoordinates(e, canvas);
        this.holdStartTime = Date.now();
        this.lastMoveTime = Date.now();
        this.hasChanged = false;
        this.lastCoords = coords;

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
                tool: this.tool,
                id: Date.now() + Math.random() // Unique ID for splitting logic
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

        // Accurate Screen Mapping: Internal pts -> Screen pixels
        const screenX = rect.left + (coords.x / 841) * rect.width;
        const screenY = rect.top + (coords.y / 1189) * rect.height;

        input.style.left = screenX + 'px';
        input.style.top = screenY + 'px';
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
            // Use a temporary canvas context to measure text if this.ctx is not available or not the right one
            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.font = input.style.fontSize + " Inter, sans-serif";
            const metrics = tempCtx.measureText(val);
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
        this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this.gestureMode === 'nav') {
            const center = this.getGestureCenter();
            const distX = center.x - this.lastGestureCenter.x;
            const distY = center.y - this.lastGestureCenter.y;

            this.container.parentElement.scrollLeft = this.scrollStart.x - distX;
            this.container.parentElement.scrollTop = this.scrollStart.y - distY;

            const dist = this.getGestureDist();
            if (this.lastGestureDist && dist > 0) {
                const ratio = dist / this.lastGestureDist;
                if (Math.abs(1 - ratio) > 0.01) {
                    this.setZoom(this.viewport.scale * ratio);
                    this.lastGestureDist = dist;
                }
            }
            return;
        }

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

            // Input Smoothing (Moving Average): Reduces "pixelated" jitters
            const smoothingFactor = 0.5;
            const smoothedX = lastPoint.x * smoothingFactor + coords.x * (1 - smoothingFactor);
            const smoothedY = lastPoint.y * smoothingFactor + coords.y * (1 - smoothingFactor);

            const dist = Math.hypot(smoothedX - lastPoint.x, smoothedY - lastPoint.y);

            // Only add point and reset hold timer if movement is significant
            // This filters out minor tremors/jitter while holding the pen still
            if (dist > (this.tool === 'highlighter' ? 3 : 1)) {
                this.currentStroke.points.push({ x: smoothedX, y: smoothedY });
                // Only reset pause timer if movement is significant (> 5px)
                // This allows auto-shape hold to trigger even with minor tremors
                if (dist > 5) this.lastMoveTime = Date.now();
                this.render();
            }

            if (this.tool === 'eraser') {
                this.performErase(this.currentStroke);
            }
        } else if (this.tool === 'laser' && this.isDrawing) {
            this.laserTrail.push({ x: coords.x, y: coords.y, time: Date.now() });
            this.render();
        } else if (this.tool === 'zoom' && this.isMoving) {
            const dx = e.clientX - this.moveStart.x;
            const dy = e.clientY - this.moveStart.y;
            this.container.parentElement.scrollLeft = this.scrollStart.x - dx;
            this.container.parentElement.scrollTop = this.scrollStart.y - dy;
        } else if (this.isLassoing) {
            this.lassoPath.push(coords);
            this.render();
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
            this.render();
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
            this.render();
        }
    }

    handlePointerUp(e) {
        if (e) this.activePointers.delete(e.pointerId);

        if (this.activePointers.size === 0) {
            this.gestureMode = null;
        }

        if (this.tool === 'laser') {
            this.isDrawing = false;
        }

        if (this.isDrawing && this.tool !== 'laser') {
            // Shape straightening / Recognition - check if pen was HELD STILL for > 1500ms
            const pauseDuration = Date.now() - this.lastMoveTime;
            if (this.tool === 'shape' || (this.tool !== 'eraser' && pauseDuration > 1500)) {
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

        this.render(); // FINAL RENDER after all flags are cleared

        if (this.hasChanged) {
            this.pushUndo(this.currentPageIndex, this.preInteractionState);
            this.triggerAutoSave();
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

    getGestureDist() {
        const pts = Array.from(this.activePointers.values());
        if (pts.length < 2) return 0;
        return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }

    getGestureCenter() {
        const pts = Array.from(this.activePointers.values());
        if (pts.length === 0) return { x: 0, y: 0 };
        if (pts.length === 1) return pts[0];
        return {
            x: (pts[0].x + pts[1].x) / 2,
            y: (pts[0].y + pts[1].y) / 2
        };
    }

    getCoordinates(e, canvas) {
        const c = canvas || this.activeCanvas;
        if (!c) return { x: 0, y: 0 };
        const rect = c.getBoundingClientRect();

        const baseW = 841;
        const baseH = 1189;

        // Perfect tracking: Always map current visual bounds to 841x1189 pts
        return {
            x: ((e.clientX - rect.left) / rect.width) * baseW,
            y: ((e.clientY - rect.top) / rect.height) * baseH
        };
    }

    undo() {
        if (this.undoStack.length === 0) return;
        const action = this.undoStack.pop();
        const pageIndex = action.pageIndex;
        const page = this.pages[pageIndex];
        this.redoStack.push({
            pageIndex: pageIndex,
            strokes: JSON.stringify(page.strokes)
        });
        page.strokes = JSON.parse(action.strokes);
        this.selectedStrokes = [];
        this.lassoPath = null;
        this.saveNotes();
        this.render();
    }

    redo() {
        if (this.redoStack.length === 0) return;
        const action = this.redoStack.pop();
        const pageIndex = action.pageIndex;
        const page = this.pages[pageIndex];
        this.undoStack.push({
            pageIndex: pageIndex,
            strokes: JSON.stringify(page.strokes)
        });
        page.strokes = JSON.parse(action.strokes);
        this.selectedStrokes = [];
        this.lassoPath = null;
        this.saveNotes();
        this.render();
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
        const ep2 = eraser.points[eraser.points.length - 1];
        const ep1 = eraser.points[eraser.points.length - 2];
        if (this.eraseEntireStroke) {
            this.currentPage.strokes = this.currentPage.strokes.filter(stroke => {
                if (!stroke.points || stroke.points.length < 2) return true;
                for (let i = 0; i < stroke.points.length - 1; i++) {
                    if (this.segmentsDistance(ep1, ep2, stroke.points[i], stroke.points[i + 1]) < radius) return false;
                }
                return true;
            });
        } else {
            // Standard Erasing: Split strokes at intersection points
            let newStrokes = [];
            this.currentPage.strokes.forEach(s => {
                if (!s.points || s.points.length < 2 || s.type === 'image' || s.type === 'text') {
                    newStrokes.push(s);
                    return;
                }

                let currentPath = [];
                for (let i = 0; i < s.points.length - 1; i++) {
                    const s1 = s.points[i];
                    const s2 = s.points[i + 1];
                    // Eraser line segment against stroke line segment
                    const hit = this.segmentsDistance(ep1, ep2, s1, s2) < radius;

                    if (hit) {
                        if (currentPath.length > 0) {
                            newStrokes.push({ ...s, points: currentPath, id: Date.now() + Math.random() });
                            currentPath = [];
                        }
                    } else {
                        if (currentPath.length === 0) currentPath.push(s1);
                        currentPath.push(s2);
                    }
                }
                if (currentPath.length > 1) {
                    newStrokes.push({ ...s, points: currentPath, id: Date.now() + Math.random() });
                }
            });
            this.currentPage.strokes = newStrokes;
        }
        // Force immediate render for erase feedback
        this.render();
    }

    segmentsDistance(p1, p2, p3, p4) {
        return Math.min(this.distToSegment(p3, p1, p2), this.distToSegment(p4, p1, p2), this.distToSegment(p1, p3, p4), this.distToSegment(p2, p3, p4));
    }

    distToSegment(p, v, w) {
        const l2 = Math.pow(v.x - w.x, 2) + Math.pow(v.y - w.y, 2);
        if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
    }

    render() {
        const dpr = this.dpr || 8.0;
        const containers = this.container.querySelectorAll('.page-container');
        const baseW = 841;
        const baseH = 1189;

        this.pages.forEach((page, index) => {
            if (page.isVisible === false) return;
            const pContainer = containers[index];
            if (!pContainer) return;
            const bgCanvas = pContainer.querySelector('.bg-canvas');
            const inkCanvas = pContainer.querySelector('.ink-canvas');
            const bgCtx = bgCanvas.getContext('2d');
            const inkCtx = inkCanvas.getContext('2d');

            if (page.hasBgChanged !== false) {
                const img = page._pdfImageCache;
                const isPdfReady = !page.pdfBackground || (img && img.complete && img.naturalWidth > 0);

                if (isPdfReady) {
                    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
                    bgCtx.clearRect(0, 0, baseW, baseH);

                    if (page.pdfBackground) {
                        if (!img) {
                            page._pdfImageCache = new Image();
                            page._pdfImageCache.src = page.pdfBackground;
                            page._pdfImageCache.onload = () => { page.hasBgChanged = true; this.render(); };
                        } else {
                            bgCtx.drawImage(img, 0, 0, baseW, baseH);
                        }
                    }

                    if (page.template === 'dotted') this.drawDotsTo(bgCtx, baseW, baseH);
                    else if (page.template === 'grid') this.drawGridTo(bgCtx, baseW, baseH);

                    page.hasBgChanged = false;
                } else {
                    // PDF image is still loading, ensure we have the image object and listener
                    if (!img) {
                        page._pdfImageCache = new Image();
                        page._pdfImageCache.src = page.pdfBackground;
                        page._pdfImageCache.onload = () => { page.hasBgChanged = true; this.render(); };
                    }
                }
            }

            inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            inkCtx.clearRect(0, 0, baseW, baseH);
            this.ctx = inkCtx;
            page.strokes.forEach(s => this.drawStroke(s));
            if (this.currentPageIndex === index && this.currentStroke) {
                this.drawStroke(this.currentStroke);
                if (this.tool === 'eraser' && this.isDrawing) {
                    const last = this.currentStroke.points[this.currentStroke.points.length - 1];
                    inkCtx.beginPath(); inkCtx.arc(last.x, last.y, this.lineWidth / 2, 0, Math.PI * 2);
                    inkCtx.fillStyle = 'rgba(0,122,255,0.1)'; inkCtx.fill();
                }
            }
            if (this.currentPageIndex === index && (this.lassoPath || this.selectedStrokes.length > 0)) {
                this.renderOverlays(inkCtx, index);
            }

            // Laser Trail
            if (this.currentPageIndex === index && this.laserTrail.length > 0) {
                const now = Date.now();
                this.laserTrail = this.laserTrail.filter(p => now - p.time < 1000);
                if (this.laserTrail.length > 1) {
                    inkCtx.strokeStyle = '#ff2d55';
                    inkCtx.lineWidth = 3;
                    inkCtx.lineCap = 'round';
                    inkCtx.lineJoin = 'round';
                    for (let i = 0; i < this.laserTrail.length - 1; i++) {
                        const p1 = this.laserTrail[i];
                        const p2 = this.laserTrail[i + 1];
                        const opacity = 1 - ((now - p1.time) / 1000);
                        inkCtx.globalAlpha = Math.max(0, opacity);
                        inkCtx.beginPath(); inkCtx.moveTo(p1.x, p1.y); inkCtx.lineTo(p2.x, p2.y);
                        inkCtx.stroke();
                    }
                    inkCtx.globalAlpha = 1;
                }
                // Request next frame for laser fade
                requestAnimationFrame(() => this.render());
            }
        });
    }

    renderOverlays(ctx, index) {
        if (this.lassoPath) {
            ctx.beginPath(); ctx.setLineDash([5, 5]); ctx.strokeStyle = '#007aff'; ctx.lineWidth = 1;
            this.lassoPath.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
            ctx.stroke(); ctx.setLineDash([]);
            if (!this.isLassoing) { ctx.fillStyle = 'rgba(0, 122, 255, 0.05)'; ctx.fill(); }
        }
        if (this.selectedStrokes.length > 0) {
            const bounds = this.getSelectionBounds();
            if (bounds) {
                ctx.strokeStyle = '#007aff'; ctx.setLineDash([5, 5]); ctx.lineWidth = 1;
                ctx.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
                ctx.setLineDash([]); ctx.fillStyle = 'white'; ctx.beginPath();
                ctx.arc(bounds.x + bounds.w, bounds.y + bounds.h, 6, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
            }
        }
    }

    drawDotsTo(ctx, w, h) {
        ctx.fillStyle = '#ccc';
        for (let x = 30; x < w; x += 30) {
            for (let y = 30; y < h; y += 30) {
                ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill();
            }
        }
    }

    drawGridTo(ctx, w, h) {
        ctx.strokeStyle = '#e0e0e0'; ctx.lineWidth = 0.5; ctx.beginPath();
        for (let x = 30; x < w; x += 30) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
        for (let y = 30; y < h; y += 30) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
        ctx.stroke();
    }

    showLassoMenu(x, y, isPasteMode = false) {
        let menu = document.getElementById('lasso-menu');
        if (!menu) { menu = document.createElement('div'); menu.id = 'lasso-menu'; document.body.appendChild(menu); }
        menu.innerHTML = isPasteMode ? `<button id="lasso-paste">Paste</button>` : `
            <button id="lasso-cut">Cut</button> <button id="lasso-copy">Copy</button>
            <button id="lasso-duplicate">Duplicate</button> <button id="lasso-delete" style="color:red">Delete</button>`;

        menu.onclick = (e) => {
            const btn = e.target;
            if (btn.id === 'lasso-cut') this.cutSelection();
            if (btn.id === 'lasso-copy') this.copySelection();
            if (btn.id === 'lasso-duplicate') this.duplicateSelection();
            if (btn.id === 'lasso-delete') this.deleteSelection();
            if (btn.id === 'lasso-paste') this.pasteSelection(this.lastCoords);
            menu.classList.add('hidden');
        };

        menu.classList.remove('hidden');
        menu.style.left = x + 'px'; menu.style.top = y + 'px';
    }

    duplicateSelection() {
        if (this.selectedStrokes.length === 0) return;
        this.pushUndo(this.currentPageIndex, JSON.stringify(this.currentPage.strokes));
        const newStrokes = JSON.parse(JSON.stringify(this.selectedStrokes));
        newStrokes.forEach(s => {
            if (s.type === 'text' || s.type === 'image') {
                s.x += 20; s.y += 20;
            } else {
                s.points.forEach(p => { p.x += 20; p.y += 20; });
            }
            this.currentPage.strokes.push(s);
        });
        this.selectedStrokes = newStrokes;
        this.render();
        this.saveNotes();
    }

    cutSelection() {
        this.copySelection();
        this.deleteSelection();
    }

    pasteSelection(coords) {
        if (!this.clipboard) return;
        this.pushUndo(this.currentPageIndex, JSON.stringify(this.currentPage.strokes));
        const strokes = JSON.parse(this.clipboard);
        // Recalculate center
        let minX = Infinity, minY = Infinity;
        strokes.forEach(s => {
            if (s.type === 'text' || s.type === 'image') { minX = Math.min(minX, s.x); minY = Math.min(minY, s.y); }
            else s.points.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); });
        });
        const dx = (coords?.x || 100) - minX;
        const dy = (coords?.y || 100) - minY;

        strokes.forEach(s => {
            if (s.type === 'text' || s.type === 'image') { s.x += dx; s.y += dy; }
            else s.points.forEach(p => { p.x += dx; p.y += dy; });
            this.currentPage.strokes.push(s);
        });
        this.render();
        this.saveNotes();
    }

    copySelection() { this.clipboard = JSON.stringify(this.selectedStrokes); }
    deleteSelection() {
        this.currentPage.strokes = this.currentPage.strokes.filter(s => !this.selectedStrokes.includes(s));
        this.selectedStrokes = []; this.lassoPath = null; this.render();
    }

    drawStroke(s) {
        if (!s) return;

        // Handle Non-Path Strokes
        if (s.type === 'text') {
            this.ctx.fillStyle = s.color || '#000000';
            this.ctx.font = `${s.size || 16}px Inter, sans-serif`;
            this.ctx.textBaseline = 'top';
            this.ctx.fillText(s.text || '', s.x, s.y);
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
        if (!points || points.length === 0) return;
        const len = points.length;

        this.ctx.lineWidth = s.width;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.strokeStyle = s.color === 'eraser' ? '#ffffff' : s.color;
        this.ctx.globalAlpha = s.opacity || 1;

        // Force maximum smoothing quality for organic curves
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';

        this.ctx.beginPath();
        if (len === 1) {
            this.ctx.arc(points[0].x, points[0].y, s.width / 2, 0, Math.PI * 2);
            this.ctx.fill();
        } else if (s.isShape) {
            // SHARP RENDERING for geometric shapes (Rectangle, Triangle, Square, etc.)
            this.ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < len; i++) {
                this.ctx.lineTo(points[i].x, points[i].y);
            }
            this.ctx.stroke();
        } else {
            this.ctx.moveTo(points[0].x, points[0].y);
            if (len === 2) {
                this.ctx.lineTo(points[1].x, points[1].y);
            } else {
                let i;
                for (i = 1; i < len - 2; i++) {
                    const c = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
                    this.ctx.quadraticCurveTo(points[i].x, points[i].y, c.x, c.y);
                }
                this.ctx.quadraticCurveTo(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y);
            }
            this.ctx.stroke();
        }
        this.ctx.globalAlpha = 1;
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

    triggerAutoSave() {
        const status = document.getElementById('save-status');
        if (status) {
            status.innerText = 'Saving...';
            status.style.opacity = '1';
        }

        if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = setTimeout(() => {
            this.saveNotes();
        }, 1000); // Debounce 1s
    }

    async saveNotes() {
        if (!this.store || !this.activeNotebookId) return;
        try {
            const notebookData = {
                pages: this.pages,
                lastModified: Date.now()
            };
            await this.store.set('note_' + this.activeNotebookId, notebookData);
            await this.store.set('recent_imgs', this.recentImages);
            console.log(`Notebook ${this.activeNotebookId} persisted.`);

            const status = document.getElementById('save-status');
            if (status) {
                status.innerText = 'Saved';
                setTimeout(() => { if (status.innerText === 'Saved') status.style.opacity = '0'; }, 2000);
            }
        } catch (e) {
            console.error("Save failed:", e);
            const status = document.getElementById('save-status');
            if (status) status.innerText = 'Save Error';
        }
    }

    async savePresets() {
        if (!this.store) return;
        await this.store.set('presets', this.presets);
    }

    async loadNotes() {
        // Obsolete in v6.6, logic moved to openNotebook
    }

    async loadLibraryIndex() {
        const list = await this.store.get('lumi_notebooks_list');
        this.notebooks = list || [];
    }

    async saveLibraryIndex() {
        await this.store.set('lumi_notebooks_list', this.notebooks);
    }

    async loadSharedData() {
        const recent = await this.store.get('recent_imgs');
        if (recent) this.recentImages = recent;

        const presets = await this.store.get('presets');
        if (presets) this.presets = presets;

        const openTabs = await this.store.get('open_tabs_list');
        this.openNotebookIds = openTabs || [];
    }

    async openNotebook(id) {
        if (this.activeNotebookId === id) {
            this.closeLibrary();
            this.renderTabs();
            return;
        }

        if (this.activeNotebookId) await this.saveNotes();

        const data = await this.store.get('note_' + id);
        if (data) {
            this.pages = data.pages;
            this.activeNotebookId = id;
            if (!this.openNotebookIds.includes(id)) {
                this.openNotebookIds.push(id);
            }
            await this.store.set('last_active_id', id);
            await this.store.set('open_tabs_list', this.openNotebookIds);

            this.currentPageIndex = 0;
            this.renderTabs();
            this.setupPages();
            this.render();
            this.closeLibrary();
        }
    }

    async createNotebook(name = "Untitled", parentId = null) {
        const id = 'nb_' + Date.now();
        const pid = parentId || (this.currentFolderId !== 'root' ? this.currentFolderId : null);
        const newNotebook = {
            id: id,
            name: name,
            type: 'notebook',
            parentId: pid,
            lastModified: Date.now()
        };
        this.notebooks.push(newNotebook);
        await this.saveLibraryIndex();

        const initialData = {
            pages: [{ strokes: [], template: 'plain' }],
            name: name
        };
        await this.store.set('note_' + id, initialData);
        await this.openNotebook(id);
    }

    async createFolder(name = "New Folder") {
        const id = 'fol_' + Date.now();
        const folder = {
            id: id,
            name: name,
            type: 'folder',
            parentId: this.currentFolderId !== 'root' ? this.currentFolderId : null,
            lastModified: Date.now()
        };
        this.notebooks.push(folder);
        await this.saveLibraryIndex();
        this.renderLibrary();
    }

    async deleteItem(id, type, e) {
        if (e) e.stopPropagation();
        if (!confirm(`Are you sure you want to delete this ${type}?`)) return;

        if (type === 'folder') {
            const children = this.notebooks.filter(n => n.parentId === id);
            for (const child of children) {
                await this.deleteItem(child.id, child.type);
            }
        } else {
            await this.store.delete('note_' + id);
            this.openNotebookIds = this.openNotebookIds.filter(tid => tid !== id);
            await this.store.set('open_tabs_list', this.openNotebookIds);
        }

        this.notebooks = this.notebooks.filter(n => n.id !== id);
        await this.saveLibraryIndex();

        if (this.activeNotebookId === id) {
            if (this.openNotebookIds.length > 0) {
                await this.openNotebook(this.openNotebookIds[0]);
            } else {
                this.activeNotebookId = null;
                this.renderTabs();
                this.openLibrary();
            }
        } else {
            this.renderLibrary();
            this.renderTabs();
        }
    }

    renderTabs() {
        const list = document.getElementById('tabs-list');
        if (!list) return;
        list.innerHTML = '';

        this.openNotebookIds.forEach(id => {
            const nb = this.notebooks.find(n => n.id === id);
            if (!nb) return;

            const tab = document.createElement('div');
            tab.className = `tab ${id === this.activeNotebookId ? 'active' : ''}`;
            tab.innerHTML = `
                <span class="tab-title">${nb.name}</span>
                <button class="tab-close" data-id="${id}">×</button>
            `;
            tab.onclick = () => this.openNotebook(id);

            const closeBtn = tab.querySelector('.tab-close');
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                this.closeTab(id);
            };

            list.appendChild(tab);
        });
    }

    async closeTab(id) {
        this.openNotebookIds = this.openNotebookIds.filter(tid => tid !== id);
        await this.store.set('open_tabs_list', this.openNotebookIds);

        if (this.activeNotebookId === id) {
            if (this.openNotebookIds.length > 0) {
                await this.openNotebook(this.openNotebookIds[0]);
            } else if (this.notebooks.length > 0) {
                await this.openNotebook(this.notebooks[0].id);
            } else {
                this.currentPageIndex = 0;
                this.pages = [{ strokes: [], template: 'plain' }];
                this.activeNotebookId = null;
                this.renderTabs();
                this.setupPages();
                this.render();
                this.openLibrary();
            }
        } else {
            this.renderTabs();
        }
    }

    openLibrary() {
        const lib = document.getElementById('library-view');
        lib.classList.remove('hidden');
        this.renderLibrary();
    }

    closeLibrary() {
        const lib = document.getElementById('library-view');
        lib.classList.add('hidden');
    }

    async toggleFavorite(id, e) {
        if (e) e.stopPropagation();
        const item = this.notebooks.find(n => n.id === id);
        if (item) {
            item.favorite = !item.favorite;
            await this.saveLibraryIndex();
            this.renderLibrary();
        }
    }

    async renameItem(id, type, e) {
        if (e) e.stopPropagation();
        const item = this.notebooks.find(n => n.id === id);
        if (!item) return;

        const newName = prompt(`Rename ${type}:`, item.name);
        if (newName && newName !== item.name) {
            item.name = newName;
            item.lastModified = Date.now();
            await this.saveLibraryIndex();

            if (type === 'notebook') {
                const data = await this.store.get('note_' + id);
                if (data) {
                    data.name = newName;
                    await this.store.set('note_' + id, data);
                }
            }
            this.renderLibrary();
            this.renderTabs();
        }
    }

    async moveItem(id, type, e) {
        if (e) e.stopPropagation();
        this.movingItemId = id;
        this.openMovePicker();
    }

    openMovePicker() {
        const modal = document.getElementById('move-modal');
        if (modal) modal.classList.remove('hidden');
        this.renderMovePicker();
    }

    closeMovePicker() {
        const modal = document.getElementById('move-modal');
        if (modal) modal.classList.add('hidden');
        this.movingItemId = null;
    }

    renderMovePicker() {
        const list = document.getElementById('move-folder-list');
        if (!list) return;
        list.innerHTML = '';

        const itemToMove = this.notebooks.find(n => n.id === this.movingItemId);
        if (!itemToMove) return;

        // 1. Root/Home Option
        const rootBtn = document.createElement('button');
        rootBtn.className = 'nav-item';
        rootBtn.style.textAlign = 'left';
        rootBtn.style.width = '100%';
        rootBtn.innerHTML = `🏠 Home (Root level)`;
        rootBtn.onclick = () => this.executeMove(null);
        list.appendChild(rootBtn);

        // 2. Folders
        const folders = this.notebooks.filter(f => {
            if (f.type !== 'folder') return false;
            if (f.id === this.movingItemId) return false;
            return true;
        });

        folders.forEach(f => {
            const btn = document.createElement('button');
            btn.className = 'nav-item';
            btn.style.textAlign = 'left';
            btn.style.width = '100%';
            btn.innerHTML = `<div class="premium-icon icon-folder" style="width:16px; height:12px; transform: scale(0.8); display:inline-block; margin-right:8px;"></div> ${f.name}`;
            btn.onclick = () => this.executeMove(f.id);
            list.appendChild(btn);
        });
    }

    async executeMove(targetId) {
        const item = this.notebooks.find(n => n.id === this.movingItemId);
        if (item) {
            item.parentId = targetId;
            item.lastModified = Date.now();
            await this.saveLibraryIndex();
            this.renderLibrary();
        }
        this.closeMovePicker();
    }

    async setItemColor(color) {
        const item = this.notebooks.find(n => n.id === this.selectedMenuId);
        if (item) {
            item.color = color;
            await this.saveLibraryIndex();
            this.renderLibrary();

            // Highlight active in UI
            document.querySelectorAll('.color-option').forEach(opt => {
                opt.classList.toggle('active', opt.dataset.color === color);
            });
        }
    }

    openActionMenu(id, type, e) {
        if (e) e.stopPropagation();
        this.selectedMenuId = id;
        const item = this.notebooks.find(n => n.id === id);
        if (!item) return;

        document.getElementById('action-menu-title').textContent = `${item.name} Options`;
        document.getElementById('menu-fav-btn').textContent = item.favorite ? '⭐ Unfavorite' : '☆ Favorite';

        // Highlight current color
        const currentColor = item.color || 'default';
        document.querySelectorAll('.color-option').forEach(opt => {
            opt.classList.toggle('active', opt.dataset.color === currentColor);
        });

        const modal = document.getElementById('action-menu-modal');
        modal.classList.remove('hidden');
    }

    closeActionMenu() {
        document.getElementById('action-menu-modal').classList.add('hidden');
        this.selectedMenuId = null;
    }

    renderLibrary() {
        const grid = document.getElementById('notebook-grid');
        if (!grid) return;

        grid.innerHTML = '';
        grid.className = this.viewMode === 'grid' ? 'notebook-grid' : 'notebook-list';

        this.renderBreadcrumbs();
        this.renderSidebarFolders();

        let items = this.notebooks;

        // 1. Filter by category
        if (this.libraryCategory === 'recent') {
            items = [...items].sort((a, b) => b.lastModified - a.lastModified).slice(0, 8);
        } else if (this.libraryCategory === 'favorites') {
            items = items.filter(n => n.favorite);
        } else {
            items = items.filter(n => (n.parentId || 'root') === (this.currentFolderId === 'root' ? 'root' : this.currentFolderId));
        }

        // 2. Filter by Search
        if (this.searchQuery) {
            items = items.filter(n => n.name.toLowerCase().includes(this.searchQuery.toLowerCase()));
        }

        // 3. Sort
        if (this.sortBy === 'name') {
            items.sort((a, b) => a.name.localeCompare(b.name));
        } else {
            items.sort((a, b) => b.lastModified - a.lastModified);
        }

        // 4. Render add card in grid mode
        if (this.viewMode === 'grid' && this.libraryCategory === 'all') {
            const addCard = document.createElement('div');
            addCard.className = 'notebook-card add-card';
            addCard.innerHTML = `
                <div class="card-thumb">
                    <div class="premium-icon icon-notebook" style="opacity:0.2;"></div>
                    <span style="position:absolute; font-size:32px; color:#c7c7cc; font-weight:300;">+</span>
                </div>
                <div class="card-title">New Note</div>
            `;
            addCard.onclick = () => this.createNotebook(`Note ${Date.now().toString().slice(-4)}`);
            grid.appendChild(addCard);
        }

        items.forEach(item => {
            const isFolder = item.type === 'folder';
            const iconClass = isFolder ? 'icon-folder' : 'icon-notebook';
            const colorClass = item.color && item.color !== 'default' ? `color-${item.color}` : '';

            if (this.viewMode === 'grid') {
                const card = document.createElement('div');
                card.className = 'notebook-card';
                card.innerHTML = `
                    <button class="card-more-btn">•••</button>
                    <div class="card-thumb"><div class="premium-icon ${iconClass} ${colorClass}"></div></div>
                    <div class="card-title">${item.name}</div>
                `;
                card.onclick = () => isFolder ? this.navigateToFolder(item.id) : this.openNotebook(item.id);
                card.querySelector('.card-more-btn').onclick = (e) => this.openActionMenu(item.id, item.type, e);
                grid.appendChild(card);
            } else {
                const row = document.createElement('div');
                row.className = 'list-item';
                row.innerHTML = `
                    <div class="item-icon"><div class="premium-icon ${iconClass} ${colorClass}"></div></div>
                    <div class="item-info">
                        <div class="item-title">${item.name}</div>
                        <div class="item-meta">${new Date(item.lastModified).toLocaleDateString()}</div>
                    </div>
                    <button class="card-more-btn" style="position:relative;">•••</button>
                `;
                row.onclick = () => isFolder ? this.navigateToFolder(item.id) : this.openNotebook(item.id);
                row.querySelector('.card-more-btn').onclick = (e) => this.openActionMenu(item.id, item.type, e);
                grid.appendChild(row);
            }
        });
    }

    renderSidebarFolders() {
        const list = document.getElementById('sidebar-folder-list');
        if (!list) return;
        list.innerHTML = '';

        const folders = this.notebooks.filter(n => n.type === 'folder');
        folders.forEach(f => {
            const btn = document.createElement('button');
            btn.className = `nav-item ${this.currentFolderId === f.id ? 'active' : ''}`;
            btn.style.display = 'flex';
            btn.style.alignItems = 'center';
            btn.style.gap = '8px';
            const colorClass = f.color && f.color !== 'default' ? `color-${f.color}` : '';
            btn.innerHTML = `<div class="premium-icon icon-folder ${colorClass}" style="width:16px; height:12px; transform: scale(0.8);"></div> <span>${f.name}</span>`;
            btn.onclick = () => {
                this.libraryCategory = 'all';
                this.navigateToFolder(f.id);
            };
            list.appendChild(btn);
        });
    }


    renderBreadcrumbs() {
        const crumbs = document.getElementById('library-breadcrumbs');
        crumbs.innerHTML = '';

        let path = [{ id: 'root', name: 'Notebooks' }];
        if (this.currentFolderId !== 'root') {
            let curr = this.notebooks.find(n => n.id === this.currentFolderId);
            let folderPath = [];
            while (curr) {
                folderPath.unshift(curr);
                curr = this.notebooks.find(n => n.id === curr.parentId);
            }
            path = path.concat(folderPath);
        }

        path.forEach((p, i) => {
            const span = document.createElement('span');
            span.className = 'breadcrumb-item';
            span.textContent = p.name;
            if (i < path.length - 1) {
                span.onclick = () => this.navigateToFolder(p.id);
                const slash = document.createElement('span');
                slash.textContent = ' / ';
                crumbs.appendChild(span);
                crumbs.appendChild(slash);
            } else {
                crumbs.appendChild(span);
            }
        });
    }

    navigateToFolder(id) {
        this.currentFolderId = id;
        this.renderLibrary();
    }

    setupLibraryListeners() {
        const backBtn = document.querySelector('.back-btn');
        if (backBtn) backBtn.onclick = () => this.openLibrary();

        const closeLibBtn = document.getElementById('close-library-btn');
        if (closeLibBtn) closeLibBtn.onclick = () => this.closeLibrary();

        const closeMoveBtn = document.getElementById('close-move-modal-btn');
        if (closeMoveBtn) closeMoveBtn.onclick = () => this.closeMovePicker();

        const closeActionMenuBtn = document.getElementById('close-action-menu-btn');
        if (closeActionMenuBtn) closeActionMenuBtn.onclick = () => this.closeActionMenu();

        document.getElementById('menu-fav-btn').onclick = () => {
            this.toggleFavorite(this.selectedMenuId);
            this.closeActionMenu();
        };
        document.getElementById('menu-rename-btn').onclick = () => {
            const item = this.notebooks.find(n => n.id === this.selectedMenuId);
            this.renameItem(this.selectedMenuId, item.type);
            this.closeActionMenu();
        };
        document.getElementById('menu-move-btn').onclick = () => {
            const item = this.notebooks.find(n => n.id === this.selectedMenuId);
            this.moveItem(this.selectedMenuId, item.type);
            this.closeActionMenu();
        };
        document.getElementById('menu-delete-btn').onclick = () => {
            const item = this.notebooks.find(n => n.id === this.selectedMenuId);
            this.deleteItem(this.selectedMenuId, item.type);
            this.closeActionMenu();
        };

        document.querySelectorAll('.color-option').forEach(opt => {
            opt.onclick = () => this.setItemColor(opt.dataset.color);
        });

        const newFolderBtn = document.getElementById('new-folder-btn');
        if (newFolderBtn) newFolderBtn.onclick = () => {
            const name = prompt("Enter Folder Name:", "New Folder");
            if (name) this.createFolder(name);
        };

        const viewToggleBtn = document.getElementById('view-toggle-btn');
        if (viewToggleBtn) viewToggleBtn.onclick = (e) => {
            this.viewMode = this.viewMode === 'grid' ? 'list' : 'grid';
            e.target.textContent = this.viewMode === 'grid' ? 'List View' : 'Grid View';
            this.renderLibrary();
        };

        const searchInput = document.getElementById('lib-search-input');
        if (searchInput) {
            searchInput.oninput = (e) => {
                this.searchQuery = e.target.value;
                this.renderLibrary();
            };
        }

        const sortSelect = document.getElementById('lib-sort-select');
        if (sortSelect) {
            sortSelect.onchange = (e) => {
                this.sortBy = e.target.value;
                this.renderLibrary();
            };
        }

        const navItems = document.querySelectorAll('.library-sidebar .nav-item[data-view]');
        navItems.forEach(item => {
            item.onclick = (e) => {
                navItems.forEach(btn => btn.classList.remove('active'));
                e.target.classList.add('active');
                this.libraryCategory = e.target.dataset.view;
                if (this.libraryCategory === 'all') this.currentFolderId = 'root';
                this.renderLibrary();
            };
        });

        const addTabBtn = document.getElementById('add-notebook-tab-btn');
        if (addTabBtn) addTabBtn.onclick = () => this.createNotebook(`Note ${Date.now().toString().slice(-4)}`);

        // Pages Sidebar close handlers
        const closeSidebarBtn = document.getElementById('close-pages-sidebar-btn');
        if (closeSidebarBtn) closeSidebarBtn.onclick = () => this.closePagesOverview();
    }

    openPagesOverview() {
        console.log('📑 openPagesOverview called (v9.1)');
        const sidebar = document.getElementById('pages-sidebar');

        if (!sidebar) {
            alert('Critical Error: Sidebar ID not found in DOM');
            return;
        }

        // Force visibility styles
        sidebar.style.display = 'flex';
        sidebar.style.zIndex = '200000'; // Extreme z-index

        // Toggle hidden class
        if (sidebar.classList.contains('hidden')) {
            console.log('📑 Showing Sidebar');
            sidebar.classList.remove('hidden');
            try {
                this.renderPagesOverview();
            } catch (e) {
                console.error('Render error:', e);
                alert('Render error: ' + e.message);
            }
        } else {
            console.log('📑 Hiding Sidebar');
            sidebar.classList.add('hidden');
        }
    }

    closePagesOverview() {
        const sidebar = document.getElementById('pages-sidebar');
        if (sidebar) sidebar.classList.add('hidden');
    }

    renderPagesOverview() {
        // Find grid inside CSS class .pages-sidebar-grid
        const grid = document.getElementById('pages-grid');
        console.log('Sidebar Grid element:', grid);

        if (!grid) {
            console.error('❌ Sidebar Grid not found!');
            return;
        }

        console.log(`📄 Rendering ${this.pages.length} pages`);
        grid.innerHTML = '';

        this.pages.forEach((page, index) => {
            const card = document.createElement('div');
            card.className = 'page-thumbnail-card';
            card.draggable = true;
            card.dataset.pageIndex = index;
            if (index === this.currentPageIndex) card.classList.add('current-page');

            // Create thumbnail preview
            const preview = document.createElement('div');
            preview.className = 'page-thumbnail-preview';

            const canvas = document.createElement('canvas');
            canvas.width = 841;
            canvas.height = 1189;
            const ctx = canvas.getContext('2d');

            // Draw background
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, 841, 1189);

            // Draw PDF background if exists
            if (page.pdfBackground && page._pdfImageCache) {
                const img = page._pdfImageCache;
                if (img.complete && img.naturalWidth > 0) {
                    ctx.drawImage(img, 0, 0, 841, 1189);
                }
            }

            // Draw template
            if (page.template === 'dotted') this.drawDotsTo(ctx, 841, 1189);
            else if (page.template === 'grid') this.drawGridTo(ctx, 841, 1189);

            // Draw strokes (simplified)
            page.strokes.forEach(stroke => {
                if (stroke.type === 'pen' || stroke.type === 'highlighter') {
                    ctx.strokeStyle = stroke.color || '#000';
                    ctx.lineWidth = (stroke.lineWidth || 2) * 0.5; // Scale down for thumbnail
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    if (stroke.type === 'highlighter') ctx.globalAlpha = 0.3;

                    ctx.beginPath();
                    stroke.points.forEach((p, i) => {
                        if (i === 0) ctx.moveTo(p.x, p.y);
                        else ctx.lineTo(p.x, p.y);
                    });
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                }
            });

            preview.appendChild(canvas);

            // Create info section
            const info = document.createElement('div');
            info.className = 'page-thumbnail-info';

            const number = document.createElement('div');
            number.className = 'page-thumbnail-number';
            number.textContent = `Page ${index + 1}`;

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'page-thumbnail-delete';
            deleteBtn.textContent = 'Delete';
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                this.deletePage(index);
            };

            info.appendChild(number);
            info.appendChild(deleteBtn);

            card.appendChild(preview);
            card.appendChild(info);

            // Drag and drop handlers
            card.ondragstart = (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', index);
                card.classList.add('dragging');
            };

            card.ondragend = () => {
                card.classList.remove('dragging');
                document.querySelectorAll('.page-thumbnail-card').forEach(c => c.classList.remove('drag-over'));
            };

            card.ondragover = (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                card.classList.add('drag-over');
            };

            card.ondragleave = () => {
                card.classList.remove('drag-over');
            };

            card.ondrop = (e) => {
                e.preventDefault();
                card.classList.remove('drag-over');
                const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
                const toIndex = index;
                if (fromIndex !== toIndex) {
                    this.reorderPage(fromIndex, toIndex);
                }
            };

            // Click to navigate
            card.onclick = () => {
                this.currentPageIndex = index;
                this.closePagesOverview();
                this.render();
                this.updatePageIndicator();
            };

            grid.appendChild(card);
        });
    }

    reorderPage(fromIndex, toIndex) {
        const page = this.pages.splice(fromIndex, 1)[0];
        this.pages.splice(toIndex, 0, page);

        // Update current page index if needed
        if (this.currentPageIndex === fromIndex) {
            this.currentPageIndex = toIndex;
        } else if (fromIndex < this.currentPageIndex && toIndex >= this.currentPageIndex) {
            this.currentPageIndex--;
        } else if (fromIndex > this.currentPageIndex && toIndex <= this.currentPageIndex) {
            this.currentPageIndex++;
        }

        this.saveNotes();
        this.setupPages();
        this.render();
        this.renderPagesOverview();
    }

    deletePage(index) {
        if (this.pages.length === 1) {
            alert('Cannot delete the last page');
            return;
        }

        if (!confirm(`Delete page ${index + 1}?`)) return;

        this.pages.splice(index, 1);

        // Adjust current page index
        if (this.currentPageIndex >= this.pages.length) {
            this.currentPageIndex = this.pages.length - 1;
        } else if (this.currentPageIndex > index) {
            this.currentPageIndex--;
        }

        this.saveNotes();
        this.setupPages();
        this.render();
        this.renderPagesOverview();
        this.updatePageIndicator();
    }

    async importPDF(files) {
        const fileList = files instanceof FileList ? Array.from(files) : [files];
        if (fileList.length === 0) return;

        // Show loading feedback immediately
        const loadingAlert = document.createElement('div');
        loadingAlert.style = "position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:rgba(0,0,0,0.8); color:white; padding:20px 40px; border-radius:12px; z-index:10000; font-weight:600;";
        loadingAlert.textContent = "Processing PDF... Please wait";
        document.body.appendChild(loadingAlert);

        try {
            if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js library not found - please refresh');
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

            for (const file of fileList) {
                console.log('📄 Processing:', file.name);

                // If no notebook is active, create a new one for this PDF
                let createdNew = false;
                if (!this.activeNotebookId) {
                    const id = 'nb_' + Date.now();
                    const newEntry = {
                        id: id,
                        name: file.name.replace('.pdf', ''),
                        type: 'notebook',
                        parentId: this.currentFolderId === 'root' ? null : this.currentFolderId,
                        lastModified: Date.now()
                    };
                    this.notebooks.push(newEntry);
                    this.activeNotebookId = id;
                    this.pages = []; // Reset pages to import PDF as content
                    createdNew = true;
                    console.log('✨ Created new notebook for PDF:', id);
                }

                const arrayBuffer = await file.arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const img = await this.renderPDFPage(page);
                    this.pages.push({
                        strokes: [],
                        template: 'plain',
                        pdfBackground: img
                    });
                }

                if (createdNew) {
                    await this.saveLibraryIndex();
                    this.closeLibrary();
                }
            }

            await this.saveNotes();
            this.setupPages();
            this.render();

            loadingAlert.textContent = "Import Complete! 🎉";
            setTimeout(() => loadingAlert.remove(), 1500);

        } catch (error) {
            console.error('❌ PDF Error:', error);
            loadingAlert.style.background = "#ff3b30";
            loadingAlert.textContent = "Import Failed: Invalid File";
            setTimeout(() => loadingAlert.remove(), 3000);
            alert("Could not import PDF. Please ensure it is a valid PDF file.");
        }
    }

    async renderPDFPage(pdfPage) {
        try {
            // Optimized Quality: Scale 2.5 provides crisp retina-level detail without crashing mobile browsers
            const viewport = pdfPage.getViewport({ scale: 2.5 });
            console.log(`Rendering PDF page at Optimized Quality: ${viewport.width}x${viewport.height}`);

            // Create temporary canvas for PDF rendering
            const tempCanvas = document.createElement('canvas');
            const context = tempCanvas.getContext('2d', {
                alpha: false,
                willReadFrequently: false
            });
            tempCanvas.width = viewport.width;
            tempCanvas.height = viewport.height;

            // Render PDF page to canvas
            await pdfPage.render({
                canvasContext: context,
                viewport: viewport,
                intent: 'display'
            }).promise;

            // Convert to data URL
            const dataURL = tempCanvas.toDataURL('image/png', 0.8);
            console.log(`PDF page rendered successfully, data URL length: ${dataURL.length}`);
            return dataURL;
        } catch (error) {
            console.error('Error rendering PDF page:', error);
            throw error;
        }
    }

    updatePageIndicator() {
        const indicator = document.getElementById('page-indicator-text');
        if (indicator) {
            indicator.textContent = `Page ${this.currentPageIndex + 1} / ${this.pages.length}`;
        }
    }
}

window.addEventListener('load', () => {
    window.lumiNoteApp = new LumiNote();
    console.log('✅ LumiNote app initialized and exposed to window');
});
