const datasetSelect = document.getElementById('datasetSelect');
const refreshBtn = document.getElementById('refreshBtn');
const exportBtn = document.getElementById('exportBtn');
const imageListEl = document.getElementById('imageList');
const imageFilterEl = document.getElementById('imageFilter');
const imagePreview = document.getElementById('imagePreview');
const captionInput = document.getElementById('captionInput');
const suggestionsEl = document.getElementById('suggestions');
const cropBtn = document.getElementById('cropBtn');
const extendBtn = document.getElementById('extendBtn');
const extendTilesEl = document.getElementById('extendTiles');
const centerBtn = document.getElementById('centerBtn');
const extendTileButtons = extendTilesEl ? Array.from(extendTilesEl.querySelectorAll('.extend-tile')) : [];
const resetBtn = document.getElementById('resetBtn');
const saveBtn = document.getElementById('saveBtn');
const statusBar = document.getElementById('statusBar');
const dimensionInfo = document.getElementById('dimensionInfo');
const resizeInput = document.getElementById('resizeInput');
const resizeBtn = document.getElementById('resizeBtn');

let cropper = null;
let currentDataset = null;
let images = [];
let currentImage = null;
let globalVocabulary = [];
let datasetVocabulary = [];
let mergedVocabulary = [];
let currentSuggestions = [];
let activeSuggestionIndex = -1;

let isSnapping = false;

const SUGGESTION_LIMIT = 12;


const EXTEND_ANCHORS = ['lu', 'cu', 'ru', 'lm', 'cm', 'rm', 'ld', 'md', 'rd'];
let selectedExtendAnchor = 'cm';

if (extendTileButtons.length) {
    const initialExtendTile = extendTileButtons.find((button) => button.classList.contains('selected'))?.dataset.anchor;
    if (initialExtendTile && EXTEND_ANCHORS.includes(initialExtendTile)) {
        selectedExtendAnchor = initialExtendTile;
    }
}

function encodePath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
}

async function fetchJSON(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            const text = await response.text();
            if (text) {
                const payload = JSON.parse(text);
                if (payload.detail) {
                    message = payload.detail;
                } else if (payload.message) {
                    message = payload.message;
                }
            }
        } catch (error) {
            // ignore parse issues
        }
        throw new Error(message);
    }
    if (response.status === 204) {
        return null;
    }
    const text = await response.text();
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error('Не удалось разобрать ответ сервера');
    }
}

function setStatus(message, type = '') {
    statusBar.textContent = message || '';
    statusBar.className = 'status';
    if (type) {
        statusBar.classList.add(type);
    }
}

function updateDimensionInfo() {
    if (!cropper) {
        dimensionInfo.textContent = '';
        return;
    }
    const data = cropper.getData(true);
    const imageData = cropper.getImageData();
    const details = [
        `Выделение: ${Math.round(data.width)}×${Math.round(data.height)}`,
        `Изображение: ${Math.round(imageData.naturalWidth)}×${Math.round(imageData.naturalHeight)}`,
    ];
    if (currentImage && Array.isArray(currentImage.image_resolution)) {
        details.push(`Файл: ${currentImage.image_resolution[1]}×${currentImage.image_resolution[0]}`);
    }
    if (currentImage && Array.isArray(currentImage.train_resolution)) {
        details.push(`Train: ${currentImage.train_resolution[1]}×${currentImage.train_resolution[0]}`);
    }
    dimensionInfo.textContent = details.join('\n');
}



function renderSuggestions() {
    suggestionsEl.innerHTML = '';
    if (!currentSuggestions.length) {
        suggestionsEl.classList.remove('visible');
        activeSuggestionIndex = -1;
        return;
    }
    currentSuggestions.slice(0, SUGGESTION_LIMIT).forEach((word, index) => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.textContent = word;
        if (index === activeSuggestionIndex) {
            item.classList.add('active');
        }
        item.addEventListener('mousedown', (event) => {
            event.preventDefault();
            applySuggestion(word);
        });
        suggestionsEl.appendChild(item);
    });
    suggestionsEl.classList.add('visible');
}

function updateSuggestions() {
    const value = captionInput.value;
    const cursor = captionInput.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursor);
    const tokenIndex = beforeCursor.split(',').length - 1;
    const currentToken = beforeCursor.split(',').pop().trim().toLowerCase();
    if (!currentToken) {
        currentSuggestions = [];
        renderSuggestions();
        return;
    }
    currentSuggestions = mergedVocabulary.filter(
        (word) => word.toLowerCase().startsWith(currentToken),
    );
    if (!currentSuggestions.length) {
        suggestionsEl.classList.remove('visible');
        return;
    }
    activeSuggestionIndex = 0;
    renderSuggestions();
}

function applySuggestion(word) {
    const value = captionInput.value;
    const cursor = captionInput.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursor);
    const tokenIndex = beforeCursor.split(',').length - 1;
    const rawTokens = value.split(',');
    const trimmedTokens = rawTokens.map((token) => token.trim());
    trimmedTokens[tokenIndex] = word;
    const normalized = trimmedTokens.filter((token) => token.length);
    const newValue = normalized.join(', ');
    captionInput.value = newValue;
    const segments = newValue.split(', ');
    let newCaret = 0;
    for (let index = 0; index <= tokenIndex && index < segments.length; index += 1) {
        if (index > 0) {
            newCaret += 2;
        }
        newCaret += segments[index].length;
    }
    captionInput.selectionStart = newCaret;
    captionInput.selectionEnd = newCaret;
    if (currentImage) {
        currentImage.caption = newValue;
    }
    currentSuggestions = [];
    suggestionsEl.classList.remove('visible');
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeMaxSide(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
        return 1024;
    }
    return Math.max(1, Math.round(parsed));
}

function setExtendAnchor(anchor) {
    if (!EXTEND_ANCHORS.includes(anchor)) {
        return;
    }
    selectedExtendAnchor = anchor;
    if (!extendTileButtons.length) {
        return;
    }
    extendTileButtons.forEach((button) => {
        if (button.dataset.anchor === anchor) {
            button.classList.add('selected');
        } else {
            button.classList.remove('selected');
        }
    });
}

function getExtendAnchor() {
    return selectedExtendAnchor;
}

function handleExtendTileClick(event) {
    const target = event.target.closest('.extend-tile');
    if (!target || !extendTilesEl?.contains(target)) {
        return;
    }
    const { anchor } = target.dataset;
    if (!anchor) {
        return;
    }
    setExtendAnchor(anchor);
}

function snapCrop(options = {}) {
    if (!cropper) return null;
    if (isSnapping) return cropper.getData(true);
    const { silent = false } = options;
    const data = cropper.getData(true);
    const imageData = cropper.getImageData();
    const imageWidth = imageData.naturalWidth;
    const imageHeight = imageData.naturalHeight;
    const width = Math.min(Math.max(data.width, 1), imageWidth);
    const height = Math.min(Math.max(data.height, 1), imageHeight);
    const maxX = imageWidth - width;
    const maxY = imageHeight - height;
    const x = clamp(data.x, 0, maxX);
    const y = clamp(data.y, 0, maxY);
    const target = { x, y, width, height };
    const changed = Math.abs(target.width - data.width) > 0.49
        || Math.abs(target.height - data.height) > 0.49
        || Math.abs(target.x - data.x) > 0.49
        || Math.abs(target.y - data.y) > 0.49;
    if (changed) {
        isSnapping = true;
        try {
            cropper.setData(target);
        } finally {
            isSnapping = false;
        }
    }
    if (!silent) {
        updateDimensionInfo();
    }
    return target;
}

function centerCrop() {
    if (!cropper) return;
    const data = cropper.getData(true);
    const imageData = cropper.getImageData();
    const x = (imageData.naturalWidth - data.width) / 2;
    const y = (imageData.naturalHeight - data.height) / 2;
    cropper.setData({ x, y });
    updateDimensionInfo();
}

function resetCrop() {
    if (!cropper) return;
    cropper.reset();
    updateDimensionInfo();
}

function buildImageUrl(dataset, path) {
    return `/api/datasets/${encodeURIComponent(dataset)}/images/${encodePath(path)}?t=${Date.now()}`;
}

function loadImage(record) {
    if (!record) {
        imagePreview.src = '';
        captionInput.value = '';
        dimensionInfo.textContent = '';
        return;
    }
    if (cropper) {
        cropper.destroy();
        cropper = null;
    }
    const imageUrl = buildImageUrl(currentDataset, record.path);
    imagePreview.src = imageUrl;
    imagePreview.dataset.path = record.path;
    captionInput.value = record.caption || '';
    updateSuggestions();
    imagePreview.onload = () => {
        cropper = new Cropper(imagePreview, {
            viewMode: 1,
            autoCrop: true,
            autoCropArea: 1,
            movable: true,
            scalable: false,
            rotatable: false,
            zoomable: true,
            wheelZoomRatio: 0.1,
            background: false,
            responsive: true,
            ready() {
                snapCrop({ silent: true });
                updateDimensionInfo();
            },
            crop() {
                updateDimensionInfo();
            },
            cropend() {
                if (isSnapping) {
                    return;
                }
                snapCrop({ silent: true });
                updateDimensionInfo();
            },
        });
    };
    imagePreview.onerror = () => {
        setStatus('Не удалось загрузить изображение', 'error');
    };
}

function renderImageList() {
    imageListEl.innerHTML = '';
    const filter = imageFilterEl.value.trim().toLowerCase();
    const filtered = images.filter((record) => {
        if (!filter) return true;
        const nameMatch = record.name.toLowerCase().includes(filter);
        const captionMatch = (record.caption || '').toLowerCase().includes(filter);
        return nameMatch || captionMatch;
    });
    if (!filtered.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'Нет изображений';
        imageListEl.appendChild(empty);
        return;
    }
    filtered.forEach((record) => {
        const item = document.createElement('li');
        item.dataset.path = record.path;
        const trainResolution = Array.isArray(record.train_resolution) ? record.train_resolution : [];
        const imageResolution = Array.isArray(record.image_resolution) ? record.image_resolution : trainResolution;
        const statusClass = record.annotated ? 'status-ready' : 'status-pending';
        item.classList.add(statusClass);
        item.dataset.status = statusClass;
        if (!Number.isFinite(Number(imageResolution[0])) || !Number.isFinite(Number(imageResolution[1]))) {
            item.title = '\u041d\u0435\u0442 \u0434\u0430\043d\043d\044b\0445 \u043e \u0440\0430\0437\043c\0435\0440\0435';
        } else if (!record.annotated) {
            item.title = '\u0415\u0449\u0451 \u0431\0435\0437 \u043f\043e\0434\043f\0438\0441\0438';
        } else {
            item.title = '\u0413\043e\0442\043e\0432\043e';
        }
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = record.name;
        const resolution = document.createElement('span');
        resolution.className = 'resolution';
        resolution.textContent = `${imageResolution[1]}×${imageResolution[0]}`;
        item.appendChild(name);
        item.appendChild(resolution);
        item.addEventListener('click', () => {
            if (currentImage && currentImage.path === record.path) {
                return;
            }
            currentImage = record;
            renderImageList();
            loadImage(record);
        });
        imageListEl.appendChild(item);
    });
}

async function refreshDatasetVocabulary(dataset) {
    try {
        const data = await fetchJSON(`/api/datasets/${encodeURIComponent(dataset)}/vocabulary`);
        datasetVocabulary = Array.isArray(data?.words) ? data.words : [];
    } catch (error) {
        datasetVocabulary = [];
    }
    mergedVocabulary = Array.from(new Set([...datasetVocabulary, ...globalVocabulary]));
}

async function loadDataset(name) {
    if (!name) return;
    currentDataset = name;
    setStatus(`Загрузка датасета ${name}...`);
    try {
        const imageData = await fetchJSON(`/api/datasets/${encodeURIComponent(name)}/images`);
        await refreshDatasetVocabulary(name);
        images = (imageData?.images || []).map((record) => {
            const trainResolution = Array.isArray(record?.train_resolution) ? record.train_resolution : [];
            const imageResolution = Array.isArray(record?.image_resolution) ? record.image_resolution : trainResolution;
            return {
                ...record,
                train_resolution: trainResolution,
                image_resolution: imageResolution,
            };
        });
        if (!images.length) {
            currentImage = null;
            renderImageList();
            loadImage(null);
            setStatus('Нет изображений в этом датасете', 'error');
            return;
        }
        currentImage = images[0];
        renderImageList();
        loadImage(currentImage);
        setStatus('Готово', 'success');
    } catch (error) {
        console.error(error);
        setStatus(error.message || 'Ошибка загрузки датасета', 'error');
    }
}

async function loadDatasets(preserveSelection = true) {
    try {
        const data = await fetchJSON('/api/datasets');
        const previous = preserveSelection ? datasetSelect.value : null;
        datasetSelect.innerHTML = '';
        (data?.datasets || []).forEach((name) => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            datasetSelect.appendChild(option);
        });
        if (!datasetSelect.options.length) {
            datasetSelect.disabled = true;
            setStatus('Не найдено ни одного датасета', 'error');
            return;
        }
        datasetSelect.disabled = false;
        let target = datasetSelect.options[0].value;
        if (previous && Array.from(datasetSelect.options).some((option) => option.value === previous)) {
            target = previous;
        }
        datasetSelect.value = target;
        await loadDataset(target);
    } catch (error) {
        console.error(error);
        datasetSelect.innerHTML = '';
        setStatus(error.message || 'Не удалось получить список датасетов', 'error');
    }
}

async function shrinkToMax() {
    if (!currentDataset || !currentImage) {
        setStatus('Выберите изображение', 'error');
        return;
    }
    const value = normalizeMaxSide(resizeInput?.value);
    if (resizeInput) {
        resizeInput.value = value;
    }
    try {
        setStatus('Сжимаю...');
        const response = await fetchJSON(
            `/api/datasets/${encodeURIComponent(currentDataset)}/images/${encodePath(currentImage.path)}/resize`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ max_side: value }),
            },
        );
        if (response?.train_resolution) {
            currentImage.train_resolution = response.train_resolution;
        }
        if (response?.image_resolution) {
            currentImage.image_resolution = response.image_resolution;
        }
        renderImageList();
        loadImage(currentImage);
        setStatus('Изображение сжато', 'success');
    } catch (error) {
        console.error(error);
        setStatus(error.message || 'Ошибка сжатия', 'error');
    }
}

async function extendToGrid() {
    if (!currentDataset || !currentImage) {
        setStatus('Выберите изображение', 'error');
        return;
    }
    const anchor = getExtendAnchor();
    if (!EXTEND_ANCHORS.includes(anchor)) {
        setStatus('Выберите расположение исходника', 'error');
        return;
    }
    try {
        setStatus('Расширяю...');
        const response = await fetchJSON(
            `/api/datasets/${encodeURIComponent(currentDataset)}/images/${encodePath(currentImage.path)}/extend`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ anchor }),
            },
        );
        const status = response?.status || 'extended';
        if (response?.train_resolution) {
            currentImage.train_resolution = response.train_resolution;
        }
        if (response?.image_resolution) {
            currentImage.image_resolution = response.image_resolution;
        }
        renderImageList();
        if (status === 'extended') {
            loadImage(currentImage);
            setStatus('Изображение расширено', 'success');
        } else {
            updateDimensionInfo();
            setStatus('\u0418\u0437\u043e\u0431\u0440\u0430\u0436\u0435\043d\0438\0435 \u0443\u0436\u0435 \u043f\u043e\0434\0445\043e\0434\0438\0442 \u043f\043e \u0440\0430\0437\043c\0435\0440\0443', 'success');
        }
    } catch (error) {
        console.error(error);
        setStatus(error.message || 'Ошибка расширения', 'error');
    }
}

async function submitImageUpdate({
    applyCrop = false,
    refreshVocabulary = false,
    inProgressMessage = applyCrop ? 'Обрезаю...' : 'Сохраняю...',
    successMessage = applyCrop ? 'Обрезано' : 'Сохранено',
    errorMessage = applyCrop ? 'Ошибка обрезки' : 'Ошибка сохранения',
} = {}) {
    if (!currentDataset || !currentImage) {
        setStatus('Выберите изображение', 'error');
        return false;
    }
    if (applyCrop && !cropper) {
        setStatus('Кадрирование недоступно', 'error');
        return false;
    }
    const payload = {
        caption: captionInput.value.trim(),
        apply_crop: applyCrop,
    };
    if (applyCrop && cropper) {
        const data = snapCrop({ silent: true }) || cropper.getData(true);
        payload.crop_data = data;
    }
    try {
        setStatus(inProgressMessage);
        const response = await fetchJSON(
            `/api/datasets/${encodeURIComponent(currentDataset)}/images/${encodePath(currentImage.path)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            },
        );
        currentImage.caption = payload.caption;
        currentImage.annotated = currentImage.caption.trim().length > 0;
        if (response?.train_resolution) {
            currentImage.train_resolution = response.train_resolution;
        }
        if (response?.image_resolution) {
            currentImage.image_resolution = response.image_resolution;
        }
        renderImageList();
        if (refreshVocabulary) {
            await refreshDatasetVocabulary(currentDataset);
            updateSuggestions();
        }
        if (applyCrop) {
            loadImage(currentImage);
        } else {
            updateDimensionInfo();
        }
        setStatus(successMessage, 'success');
        return true;
    } catch (error) {
        console.error(error);
        setStatus(error.message || errorMessage, 'error');
        return false;
    }
}

async function saveCurrent() {
    await submitImageUpdate({ refreshVocabulary: true });
}

async function cropCurrent() {
    await submitImageUpdate({ applyCrop: true });
}

async function init() {
    try {
        const vocab = await fetchJSON('/api/vocabulary');
        globalVocabulary = Array.isArray(vocab?.words) ? vocab.words : [];
    } catch (error) {
        globalVocabulary = [];
    }
    await loadDatasets(true);
}

refreshBtn.addEventListener('click', () => {
    loadDatasets(true);
});

datasetSelect.addEventListener('change', (event) => {
    if (event.target.value) {
        loadDataset(event.target.value);
    }
});

imageFilterEl.addEventListener('input', () => {
    renderImageList();
});

captionInput.addEventListener('input', () => {
    updateSuggestions();
});

captionInput.addEventListener('keydown', (event) => {
    if (!currentSuggestions.length) {
        return;
    }
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeSuggestionIndex = (activeSuggestionIndex + 1) % currentSuggestions.length;
        renderSuggestions();
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeSuggestionIndex = (activeSuggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
        renderSuggestions();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
        if (activeSuggestionIndex >= 0) {
            event.preventDefault();
            applySuggestion(currentSuggestions[activeSuggestionIndex]);
        }
    } else if (event.key === 'Escape') {
        currentSuggestions = [];
        suggestionsEl.classList.remove('visible');
    }
});

captionInput.addEventListener('focus', () => {
    updateSuggestions();
});

captionInput.addEventListener('blur', () => {
    setTimeout(() => {
        currentSuggestions = [];
        suggestionsEl.classList.remove('visible');
    }, 150);
});

if (resizeBtn) {
    resizeBtn.addEventListener('click', shrinkToMax);
}

if (resizeInput) {
    resizeInput.addEventListener('change', () => {
        resizeInput.value = normalizeMaxSide(resizeInput.value);
    });
    resizeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            shrinkToMax();
        }
    });
}

if (extendTilesEl) {
    extendTilesEl.addEventListener('click', handleExtendTileClick);
    setExtendAnchor(selectedExtendAnchor);
}

if (cropBtn) {
    cropBtn.addEventListener('click', cropCurrent);
}

if (extendBtn) {
    extendBtn.addEventListener('click', extendToGrid);
}

centerBtn.addEventListener('click', centerCrop);
resetBtn.addEventListener('click', resetCrop);
saveBtn.addEventListener('click', saveCurrent);

exportBtn.addEventListener('click', () => {
    if (!currentDataset) {
        setStatus('Выберите датасет', 'error');
        return;
    }
    const url = `/api/datasets/${encodeURIComponent(currentDataset)}/export`;
    window.open(url, '_blank');
});

init().catch((error) => {
    console.error(error);
    setStatus(error.message || 'Ошибка инициализации', 'error');
});
