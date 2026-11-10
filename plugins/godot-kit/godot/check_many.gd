# godot-kit: loads every script named after `--` so Godot reports its parse
# and compile errors, all in one process. Run as:
#   godot --headless --path <project> --script <this file> -- res://a.gd res://b.gd
extends SceneTree

func _init() -> void:
	var failed := 0
	for path in OS.get_cmdline_user_args():
		var script = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		if script == null or not (script is Script) or not script.can_instantiate():
			failed += 1
	quit(1 if failed > 0 else 0)
