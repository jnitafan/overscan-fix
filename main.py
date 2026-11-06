"""Persistent Decky settings and additive MangoHud preset offsets."""

import asyncio
import json
import math
import os
import re
import shutil
import stat
import tempfile
from pathlib import Path

import decky


DEFAULTS = {
	"enabled": True,
    "whiteBackground": False,
	"mangohud": True,
	"scale": 1.0,
	"horizontal": 0,
	"vertical": 0,
}
MAX_OFFSET = 160
SETTINGS_PATH = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "overscan-fix-settings.json"
USER_HOME = Path(decky.DECKY_USER_HOME)
PRESETS_PATH = USER_HOME / ".config" / "MangoHud" / "presets.conf"
BACKUP_PATH = PRESETS_PATH.with_name("presets.conf.overscan-fix.bak")

# The marked blocks are the only configuration lines the plugin owns.
BEGIN = "# Overscan Fix: offsets BEGIN"
END = "# Overscan Fix: offsets END"
GENERATED_BEGIN = "# Overscan Fix: generated preset {number} BEGIN"
GENERATED_END = "# Overscan Fix: generated preset {number} END"
SECTION_RE = re.compile(r"(?m)^[ \t]*\[([^\]\r\n]+)\][^\r\n]*(?:\n|$)")
VALUE_RE = re.compile(r"^[ \t]*(offset_[xy])[ \t]*=[ \t]*([+-]?\d+)(?:[ \t]*(?:#.*)?)?$", re.M)
MANAGED_RE = re.compile(
	r"(?ms)^# Overscan Fix: offsets BEGIN\n.*?^# Overscan Fix: offsets END(?:\n|$)"
)
GENERATED_RE = re.compile(
	r"(?ms)^# Overscan Fix: generated preset ([1-4]) BEGIN\n"
	r".*?^# Overscan Fix: generated preset \1 END(?:\n|$)"
)


def sanitize(value):
	if not isinstance(value, dict):
		value = {}
	result = {
		"enabled": value.get("enabled", True) is not False,
        "whiteBackground": value.get("whiteBackground", False) is True,
		"mangohud": value.get("mangohud", True) is not False,
	}
	try:
		scale = float(value.get("scale", 1.0))
		if not math.isfinite(scale):
			scale = 1.0
	except (TypeError, ValueError, OverflowError):
		scale = 1.0
	result["scale"] = round(max(0.1, min(1.9, scale)), 3)
	for name, legacy in (("horizontal", "left"), ("vertical", "top")):
		try:
			number = float(value.get(name, value.get(legacy, 0)))
			if not math.isfinite(number):
				number = 0
		except (TypeError, ValueError, OverflowError):
			number = 0
		result[name] = int(max(-MAX_OFFSET, min(MAX_OFFSET, round(number))))
	return result


def load_settings():
	try:
		return sanitize(json.loads(SETTINGS_PATH.read_text(encoding="utf-8")))
	except (OSError, ValueError, TypeError):
		return dict(DEFAULTS)


def atomic_write(path: Path, text: str, target_user: bool = False):
	path.parent.mkdir(parents=True, exist_ok=True)
	if target_user and os.geteuid() == 0:
		owner = USER_HOME.stat()
		# Fix newly created MangoHud directories if Decky runs as root.
		for directory in (USER_HOME / ".config", path.parent):
			if directory.exists() and directory.stat().st_uid == 0:
				os.chown(directory, owner.st_uid, owner.st_gid)
	mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
	fd, tempname = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
	try:
		with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
			stream.write(text)
			stream.flush()
			os.fsync(stream.fileno())
		os.chmod(tempname, mode)
		if target_user and os.geteuid() == 0:
			owner = USER_HOME.stat()
			os.chown(tempname, owner.st_uid, owner.st_gid)
		os.replace(tempname, path)
	finally:
		if os.path.exists(tempname):
			os.unlink(tempname)


def original_content(content: str):
	# Remove fully generated preset sections first; otherwise we'd leave orphan headings.
	content = GENERATED_RE.sub("", content)
	return MANAGED_RE.sub("", content)


def current_offset(body: str, dimension: str, inherited: int = 0):
	value = inherited
	for match in VALUE_RE.finditer(body):
		if match.group(1) == dimension:
			value = int(match.group(2))
	return value


def managed_block(x: int, y: int):
	return f"{BEGIN}\noffset_x={x}\noffset_y={y}\n{END}\n"


def append_to_preset(body: str, horizontal: int, vertical: int, base_x: int, base_y: int):
	x = current_offset(body, "offset_x", base_x) + horizontal
	y = current_offset(body, "offset_y", base_y) + vertical
	return body + ("" if not body or body.endswith("\n") else "\n") + managed_block(x, y)


def build_presets(original: str, settings: dict):
	content = original_content(original)
	horizontal = settings["horizontal"]
	vertical = settings["vertical"]

	if not settings["enabled"] or not settings["mangohud"] or (
		horizontal == 0 and vertical == 0
	):
		return content

	matches = list(SECTION_RE.finditer(content))
	prefix = content[:matches[0].start()] if matches else content
	base_x = current_offset(prefix, "offset_x")
	base_y = current_offset(prefix, "offset_y")
	segments = [prefix]
	found = set()

	for index, match in enumerate(matches):
		end = matches[index + 1].start() if index + 1 < len(matches) else len(content)
		body = content[match.end():end]
		header = match.group(1).strip().lower()
		number_match = re.fullmatch(r"preset\s+([1-4])", header)

		if number_match:
			number = int(number_match.group(1))
			found.add(number)
			body = append_to_preset(body, horizontal, vertical, base_x, base_y)

		segments.extend((match.group(0), body))

	result = "".join(segments)

	for number in range(1, 5):
		if number in found:
			continue

		if result and not result.endswith("\n"):
			result += "\n"

		result += (
			f"{GENERATED_BEGIN.format(number=number)}\n"
			f"[preset {number}]\n"
			"inherit\n"
			f"{managed_block(base_x + horizontal, base_y + vertical)}"
			f"{GENERATED_END.format(number=number)}\n"
		)

	return result


def update_mangohud(settings: dict):
	original = PRESETS_PATH.read_text(encoding="utf-8") if PRESETS_PATH.exists() else ""
	updated = build_presets(original, settings)
	if updated == original:
		return
	if not PRESETS_PATH.exists() and not updated:
		return
	if PRESETS_PATH.exists() and not BACKUP_PATH.exists():
		# Single untouched backup for manual recovery. Never overwrite it.
		shutil.copy2(PRESETS_PATH, BACKUP_PATH)
	if not updated and original_content(original) == "":
		# Keep an existing file, including a previously empty presets.conf.
		atomic_write(PRESETS_PATH, "", target_user=True)
	else:
		atomic_write(PRESETS_PATH, updated, target_user=True)


class Plugin:
	def __init__(self):
		self.lock = asyncio.Lock()

	async def _main(self):
		async with self.lock:
			try:
				await asyncio.to_thread(update_mangohud, load_settings())
			except Exception as error:
				decky.logger.error("Overscan Fix: MangoHud startup sync failed: %s", error)

	async def get_settings(self):
		decky.logger.info("Overscan Fix: get_settings called")
		return load_settings()

	async def set_settings(self, value):
		settings = sanitize(value)
		async with self.lock:
			await asyncio.to_thread(
				atomic_write,
				SETTINGS_PATH,
				json.dumps(settings, indent=2) + "\n"
			)
			await asyncio.to_thread(update_mangohud, settings)
		return settings

	async def _uninstall(self):
		async with self.lock:
			try:
				await asyncio.to_thread(update_mangohud, dict(DEFAULTS, enabled=False))
			except Exception as error:
				decky.logger.error("Overscan Fix: MangoHud uninstall cleanup failed: %s", error)
