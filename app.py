import json
import threading
from pathlib import Path
from typing import Dict, List, Optional, Literal, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from PIL import Image

BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent
DATASET_ROOT = ROOT_DIR / "dataset"
METADATA_FILENAME = "metadata.json"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

GRID_SIZE = 64

try:
    RESAMPLE_MODE = Image.Resampling.LANCZOS
except AttributeError:  # Pillow<9.1 fallback
    RESAMPLE_MODE = Image.LANCZOS

app = FastAPI(title="Dataset Captioning UI")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

_store_lock = threading.Lock()


def _ensure_dataset(dataset: str) -> Path:
    train_dir = DATASET_ROOT / dataset
    if not train_dir.exists() or not train_dir.is_dir():
        raise HTTPException(status_code=404, detail="Dataset not found")
    return train_dir


def _load_metadata(dataset: str) -> Dict[str, object]:
    train_dir = _ensure_dataset(dataset)
    metadata_path = train_dir / METADATA_FILENAME
    if metadata_path.exists():
        with metadata_path.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
        if isinstance(payload, dict):
            return _normalize_metadata_keys(dataset, payload)
        return {}
    return {}


def _save_metadata(dataset: str, data: Dict[str, object]) -> None:
    train_dir = _ensure_dataset(dataset)
    metadata_path = train_dir / METADATA_FILENAME
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    normalized = _normalize_metadata_keys(dataset, data)
    with metadata_path.open("w", encoding="utf-8") as fh:
        json.dump(normalized, fh, ensure_ascii=False, indent=4, sort_keys=True)


def _split_caption(caption: str) -> List[str]:
    return [chunk.strip() for chunk in caption.split(",") if chunk.strip()]


def _collect_global_vocabulary() -> List[str]:
    words = set()
    if not DATASET_ROOT.exists():
        return []
    for metadata_path in DATASET_ROOT.rglob(METADATA_FILENAME):
        try:
            with metadata_path.open("r", encoding="utf-8") as fh:
                payload = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        for entry in payload.values():
            caption = entry.get("caption") if isinstance(entry, dict) else None
            if isinstance(caption, str):
                words.update(_split_caption(caption))
    return sorted(words)


def _collect_dataset_vocabulary(dataset: str) -> List[str]:
    items = _load_metadata(dataset)
    words = set()
    for entry in items.values():
        caption = entry.get("caption") if isinstance(entry, dict) else None
        if isinstance(caption, str):
            words.update(_split_caption(caption))
    return sorted(words)


def _list_image_files(train_dir: Path) -> List[Path]:
    files: List[Path] = []
    for path in train_dir.rglob("*"):
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
            files.append(path)
    return sorted(files, key=lambda p: p.relative_to(train_dir).as_posix().lower())


def _make_metadata_key(dataset: str, relative_path: str) -> str:
    rel = Path(relative_path.replace("\\", "/"))
    return (Path("dataset") / dataset / rel).as_posix()

def _normalize_metadata_keys(dataset: str, payload: Dict[str, object]) -> Dict[str, object]:
    normalized: Dict[str, object] = {}
    if not isinstance(payload, dict):
        return normalized
    dataset_lower = dataset.lower()
    for raw_key, value in payload.items():
        if not isinstance(raw_key, str):
            continue
        sanitized = raw_key.replace("\\", "/").strip()
        if not sanitized:
            continue
        if sanitized.startswith("./"):
            sanitized = sanitized[2:]
        sanitized = sanitized.lstrip("/")
        parts = [part for part in sanitized.split("/") if part]
        if not parts:
            continue
        original_parts = parts[:]
        fallback_key = "/".join(original_parts)
        had_dataset_prefix = False
        if original_parts and original_parts[0].lower() == "dataset":
            had_dataset_prefix = True
            parts = original_parts[1:]
        else:
            parts = original_parts
        if not parts:
            if fallback_key not in normalized:
                normalized[fallback_key] = value
            continue
        if parts[0].lower() == dataset_lower:
            rel_parts = parts[1:]
        elif not had_dataset_prefix:
            rel_parts = parts
        else:
            rel_parts = []
        rel_parts = [part for part in rel_parts if part]
        if rel_parts:
            normalized_key = _make_metadata_key(dataset, "/".join(rel_parts))
            if normalized_key not in normalized:
                normalized[normalized_key] = value
            continue
        if fallback_key not in normalized:
            normalized[fallback_key] = value
    return normalized


class CropData(BaseModel):
    x: float = Field(..., description="Left coordinate of crop box")
    y: float = Field(..., description="Top coordinate of crop box")
    width: float = Field(..., description="Width of crop box")
    height: float = Field(..., description="Height of crop box")


class UpdateRequest(BaseModel):
    caption: str = Field(default="")
    apply_crop: bool = Field(default=False)
    crop_data: Optional[CropData] = None


class ResizeRequest(BaseModel):
    max_side: int = Field(default=1024, ge=1, description="Maximum size for width/height")

class ExtendRequest(BaseModel):
    anchor: Literal['lu', 'cu', 'ru', 'lm', 'cm', 'rm', 'ld', 'md', 'rd'] = Field(default='cm')


class DatasetListResponse(BaseModel):
    datasets: List[str]


class ImageRecord(BaseModel):
    name: str
    path: str
    caption: str
    train_resolution: List[int]
    image_resolution: List[int]
    annotated: bool


class DatasetImagesResponse(BaseModel):
    dataset: str
    images: List[ImageRecord]


def _round_up_to_grid(value: int) -> int:
    """Return the smallest GRID_SIZE-multiple that fits `value`."""
    if value <= 0:
        return GRID_SIZE
    if value % GRID_SIZE == 0:
        return value
    return ((value // GRID_SIZE) + 1) * GRID_SIZE


def _aligned_resolution(height: int, width: int) -> List[int]:
    """Compute training resolution aligned to GRID_SIZE for metadata storage."""
    return [_round_up_to_grid(height), _round_up_to_grid(width)]


def _apply_crop(image_path: Path, crop: CropData) -> List[int]:
    with Image.open(image_path) as img:
        width, height = img.size
        crop_width = int(round(crop.width))
        crop_height = int(round(crop.height))
        if crop_width <= 0 or crop_height <= 0:
            raise HTTPException(status_code=400, detail="Invalid crop dimensions")
        crop_width = min(crop_width, width)
        crop_height = min(crop_height, height)
        left = int(round(crop.x))
        top = int(round(crop.y))
        max_left = max(0, width - crop_width)
        max_top = max(0, height - crop_height)
        if left < 0:
            left = 0
        if top < 0:
            top = 0
        if left > max_left:
            left = max_left
        if top > max_top:
            top = max_top
        right = left + crop_width
        bottom = top + crop_height
        cropped = img.crop((left, top, right, bottom))
        cropped.save(image_path)
        return [cropped.height, cropped.width]

def _extend_image(image_path: Path, anchor: str) -> Tuple[List[int], str]:
    normalized = (anchor or 'cm').lower()
    if len(normalized) < 2:
        normalized = 'cm'
    horizontal = normalized[0]
    vertical = normalized[1]
    with Image.open(image_path) as img:
        width, height = img.size
        target_width = ((width + GRID_SIZE - 1) // GRID_SIZE) * GRID_SIZE
        target_height = ((height + GRID_SIZE - 1) // GRID_SIZE) * GRID_SIZE
        if target_width == width and target_height == height:
            return [height, width], 'unchanged'
        extra_width = target_width - width
        extra_height = target_height - height
        horizontal_map = {
            'l': 0,
            'c': extra_width // 2,
            'm': extra_width // 2,
            'r': extra_width,
        }
        vertical_map = {
            'u': 0,
            'm': extra_height // 2,
            'd': extra_height,
        }
        offset_x = int(horizontal_map.get(horizontal, extra_width // 2))
        offset_y = int(vertical_map.get(vertical, extra_height // 2))
        suffix = image_path.suffix.lower()
        supports_transparency = suffix in {'.png', '.webp'}
        img_format = img.format
        if supports_transparency:
            if img.mode in {'RGBA', 'LA'}:
                paste_image = img.copy()
                canvas_mode = img.mode
            elif img.mode == 'L':
                canvas_mode = 'LA'
                paste_image = img.convert('LA')
            else:
                canvas_mode = 'RGBA'
                paste_image = img.convert('RGBA')
            background = (0, 0, 0, 0) if canvas_mode == 'RGBA' else (0, 0)
        else:
            if img.mode in {'1', 'L'}:
                canvas_mode = 'L'
                paste_image = img.convert('L')
                background = 255
            else:
                canvas_mode = 'RGB'
                paste_image = img.convert('RGB')
                background = (255, 255, 255)
        canvas = Image.new(canvas_mode, (target_width, target_height), background)
        canvas.paste(paste_image, (offset_x, offset_y))
        save_kwargs = {}
        if img_format:
            save_kwargs['format'] = img_format
        canvas.save(image_path, **save_kwargs)
        return [target_height, target_width], 'extended'



def _resize_image(image_path: Path, max_side: int) -> List[int]:
    max_side = max(1, int(max_side))
    with Image.open(image_path) as img:
        width, height = img.size
        longest_side = max(width, height)
        if longest_side <= max_side:
            return [height, width]
        scale = max_side / float(longest_side)
        new_width = max(1, int(round(width * scale)))
        new_height = max(1, int(round(height * scale)))
        if new_width <= 0 or new_height <= 0:
            raise HTTPException(status_code=400, detail="Resize produced invalid dimensions")
        if new_width > max_side or new_height > max_side:
            aspect_ratio = width / float(height) if height else 1.0
            if new_width >= new_height:
                new_width = max_side
                new_height = max(1, int(round(new_width / aspect_ratio)))
            else:
                new_height = max_side
                new_width = max(1, int(round(new_height * aspect_ratio)))
        if new_width == width and new_height == height:
            return [height, width]
        resized = img.resize((new_width, new_height), RESAMPLE_MODE)
        resized.save(image_path)
        return [resized.height, resized.width]


def _get_image_dimensions(path: Path) -> List[int]:
    with Image.open(path) as img:
        width, height = img.size
    return [height, width]


def _resolve_image_path(dataset: str, image_path: str) -> Path:
    train_dir = _ensure_dataset(dataset)
    candidate = (train_dir / image_path).resolve()
    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    try:
        candidate.relative_to(train_dir.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid image path") from exc
    return candidate


@app.get("/", include_in_schema=False)
async def root() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/datasets", response_model=DatasetListResponse)
async def list_datasets() -> DatasetListResponse:
    datasets = []
    if DATASET_ROOT.exists():
        for child in sorted(DATASET_ROOT.iterdir(), key=lambda p: p.name.lower()):
            if child.exists() and child.is_dir():
                datasets.append(child.name)
    return DatasetListResponse(datasets=datasets)


@app.get("/api/datasets/{dataset}/images", response_model=DatasetImagesResponse)
async def dataset_images(dataset: str) -> DatasetImagesResponse:
    train_dir = _ensure_dataset(dataset)
    metadata = _load_metadata(dataset)
    images: List[ImageRecord] = []
    for image_path in _list_image_files(train_dir):
        relative_path = image_path.relative_to(train_dir).as_posix()
        key = _make_metadata_key(dataset, relative_path)
        entry = metadata.get(key, {})
        caption_value = entry.get("caption") if isinstance(entry, dict) else ""
        caption_text = caption_value or ""
        actual_resolution = _get_image_dimensions(image_path)
        raw_resolution = entry.get("train_resolution") if isinstance(entry, dict) else None
        if isinstance(raw_resolution, list) and len(raw_resolution) == 2:
            height_value = max(int(raw_resolution[0]), int(actual_resolution[0]))
            width_value = max(int(raw_resolution[1]), int(actual_resolution[1]))
            train_resolution = _aligned_resolution(height_value, width_value)
        else:
            train_resolution = _aligned_resolution(actual_resolution[0], actual_resolution[1])
        images.append(
            ImageRecord(
                name=relative_path,
                path=relative_path,
                caption=caption_text,
                train_resolution=[int(train_resolution[0]), int(train_resolution[1])],
                image_resolution=[int(actual_resolution[0]), int(actual_resolution[1])],
                annotated=bool(caption_text.strip()),
            )
        )
    return DatasetImagesResponse(dataset=dataset, images=images)


@app.get("/api/datasets/{dataset}/images/{image_path:path}")
async def dataset_image_file(dataset: str, image_path: str) -> FileResponse:
    image_file = _resolve_image_path(dataset, image_path)
    return FileResponse(image_file)


@app.get("/api/datasets/{dataset}/metadata")
async def dataset_metadata(dataset: str) -> JSONResponse:
    metadata = _load_metadata(dataset)
    return JSONResponse(metadata)


@app.get("/api/datasets/{dataset}/vocabulary")
async def dataset_vocabulary(dataset: str) -> Dict[str, List[str]]:
    words = _collect_dataset_vocabulary(dataset)
    return {"words": words}


@app.get("/api/vocabulary")
async def vocabulary() -> Dict[str, List[str]]:
    return {"words": _collect_global_vocabulary()}


@app.post("/api/datasets/{dataset}/images/{image_path:path}/resize")
async def resize_image(dataset: str, image_path: str, payload: ResizeRequest) -> Dict[str, object]:
    image_file = _resolve_image_path(dataset, image_path)
    metadata_key = _make_metadata_key(dataset, image_path)
    with _store_lock:
        metadata = _load_metadata(dataset)
        entry = metadata.get(metadata_key)
        if not isinstance(entry, dict):
            entry = {}
        image_resolution = _resize_image(image_file, payload.max_side)
        aligned_resolution = _aligned_resolution(image_resolution[0], image_resolution[1])
        entry["caption"] = entry.get("caption", "")
        entry["train_resolution"] = aligned_resolution
        metadata[metadata_key] = entry
        _save_metadata(dataset, metadata)
    return {"status": "ok", "train_resolution": aligned_resolution, "image_resolution": image_resolution}

@app.post("/api/datasets/{dataset}/images/{image_path:path}/extend")
async def extend_image(dataset: str, image_path: str, payload: ExtendRequest) -> Dict[str, object]:
    image_file = _resolve_image_path(dataset, image_path)
    metadata_key = _make_metadata_key(dataset, image_path)
    with _store_lock:
        metadata = _load_metadata(dataset)
        entry = metadata.get(metadata_key)
        if not isinstance(entry, dict):
            entry = {}
        image_resolution, status = _extend_image(image_file, payload.anchor)
        aligned_resolution = _aligned_resolution(image_resolution[0], image_resolution[1])
        entry["caption"] = entry.get("caption", "")
        entry["train_resolution"] = aligned_resolution
        metadata[metadata_key] = entry
        _save_metadata(dataset, metadata)
    return {"status": status, "train_resolution": aligned_resolution, "image_resolution": image_resolution}



@app.post("/api/datasets/{dataset}/images/{image_path:path}")
async def update_image(dataset: str, image_path: str, payload: UpdateRequest) -> Dict[str, object]:
    image_file = _resolve_image_path(dataset, image_path)
    metadata_key = _make_metadata_key(dataset, image_path)
    with _store_lock:
        metadata = _load_metadata(dataset)
        entry = metadata.get(metadata_key, {}) if isinstance(metadata.get(metadata_key), dict) else {}
        entry["caption"] = payload.caption.strip()
        image_resolution: Optional[List[int]] = None
        if payload.apply_crop and payload.crop_data is not None:
            image_resolution = _apply_crop(image_file, payload.crop_data)
        if image_resolution is None:
            image_resolution = _get_image_dimensions(image_file)
        aligned_resolution = _aligned_resolution(image_resolution[0], image_resolution[1])
        entry["train_resolution"] = aligned_resolution
        metadata[metadata_key] = entry
        _save_metadata(dataset, metadata)
    return {"status": "ok", "train_resolution": aligned_resolution, "image_resolution": image_resolution}


@app.get("/api/datasets/{dataset}/export")
async def export_metadata(dataset: str) -> FileResponse:
    train_dir = _ensure_dataset(dataset)
    metadata_path = train_dir / METADATA_FILENAME
    if not metadata_path.exists():
        _save_metadata(dataset, {})
    metadata_path = metadata_path.resolve()
    filename = f"{dataset}_metadata.json"
    return FileResponse(metadata_path, media_type="application/json", filename=filename)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=False)







