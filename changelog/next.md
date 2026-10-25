# Notes
As this is a very huge overhaul of the previous patches, there are still some **things to improve here**. If you find anything not quite intuitive (e.g. descriptions) or know a better solution for, **let me know on Discord** :D


# Fixed
- No FE but a warning instead if you join a game and do not have the correct map locally (see section Added for *Automatic Map and Script Exchange*).
- Fixed a FE at the lobby screen when changing the balancing option.
- Tutorial-events stayed active in lobby, leading to FEs when e.g. pressing space.
- Better Chat Symbols: now working for initial messages as well.
- Ferry unloading: checks properly for ground type, avoiding Entities being stuck on water.
- Advanced Chat Commands are now properly sent and executed on every machine in parallel avoiding Desyncs (except for the explicit keyword 'local').
- Fixed speed of entities on pathways, they were off by one.
- Hotkeys keep working after changing player mid-game.
- Rightclick now copies the proper chat message (it often took the wrong line).
- SULib: SU.GameData.Set-Functions now clamp the parameter instead of modulo (e.g. 256 -> 255 instead of 0).


# Added
- Balancing-files are reloaded at every single map-start to prevent desyncs due to old settings (e.g. a player with who played UBO joins now UBO-Test).
- Added CRC-checks inside the lobby and at game-start, checking all balancing relevant things (Maps, Files, Scripts, Settings) -> find mismatching settings before playing.
- Invite-button: a menu shows up listing all your Ubisoft friends to directly invite them into your game.
- Ferry instant unloader. Note that vehicles might still be in there, as they would usually be spawned at last (furthest away), which might not always be desired as they are kind of unprotected there - can be adjusted if wanted.
- Player-change updates the GUI as well. Note that texts are not updated yet.

- **Workingarea for big temples** let priest go there automatically.

- **Automatic Map and Script Exchange**: when you join a game, the map and script (internal and external ones!) are both checked and if not existent on your machine automatically downloaded directly from the host - no need to exchange any maps/scripts anymore!

- **PioneerPath**: you can now let pioneers capture a path from A to B automatically. It's by design a bit wider than needed with some natural variations s.t. micromanaging is still quicker. You can start it **via GUI** or **Shift+rightclicking** the selected ones from their mean position the the mouse coordinate.

- **Geologists variable precision**: you can define the precision (coarse, normal, fine) of geologists **via GUI** or by **Ctrl(coarse) / Shift(fine) + rightclicking**.

- **Replay-System**: for now it's only there **for debugging** and there are a few known bugs, so use at own risk!


# Changed
- **Refactoring**: this is a huge refactoring, **checking every single patch/mod** once again, rewriting some, making it much easier to extend and add new ones and improving the overall **game stability** a lot. As there might still be **some bugs left**, these nice features stay in **Preview for now**.
