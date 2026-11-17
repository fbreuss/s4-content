# Fixed
- Fixes an error with the editor, where you could not place buildings for other tribes than roman (specifically, everything after the fishers hut in the xml file).
- Fixes an FE regarding explorer radius, happening mostly when settlers die at the dark tribes fortress.
- Fixes a bug, where workers of **small viking temples** would not start to work at all.
- Fixes a few values in the statistics.
- The pause cursor comes back again after moving the screen around.
- Makes the lobby more responsive.
- Invite overlay shows and let you invite 'offline' players too, as the Ubisoft backend does not always show the correct state.
- Fixes a zip-corruption at creation of log files.
- Fixes a bug where **construction sites lost their priority state** when un-/paused.
- Fixes a Desync caused by good distribution.
- Fixes lobbynames (no '(Troja) (Troja)' anymore, proper text-length handling) that caused issues when trying to join lobbies.
- Fixes borderscroll issues due to the Debug Overlay.
- Fixes the script settings button to endlessly wandering to the right on smaller screens.


# Added
- **Construction sites**
	- They now have good priority over all other requestors, including gold and barracks. Sites with priority get all 3 goods first.
	- They now **request resources every single tick** instead of every 15th.
- **Thieves GUI and modes**:
	- In the new GUI you can set a thief to always hold the stolen goods by default and let them drop the goods instantly.
	- At a distance < 4 they automatically keep stolen goods in their hands.
- **Marketplaces**:
	- They have now **priority over production buildings**, **except** if set to **infinity-mode**.
	- They have a **request donkeys back** button for quicker transport.
	- **Reserved number of piles** now **depend** on the total **amount of different goods you've set**. E.g. if you only set **one good** to be transported, **all 8** instead of 3 **piles request it simultaneously**, improving throughput a lot - especially in combination with auto-returning donkeys. If you send 4 goods, each one gets 2 piles and so on.
- Piles: you can now steal from piles even **while the working animation is played**. The goods that are going to be consumed by the worker remains reserved though. This also fixes a related bug for piles of crushed buildings.
- **Fog of war updates way quicker** (12 instead of 40 ticks).
- **Leveling bug fixed**: fixes a bug s.t. buildings will now always give a perfect plane area where it can be built again without the need of levelers (who until now were requested but then didn't work there at all).
- Priests now have waypoints just like soldiers already had.
- Advanced GUI interaction: ctrl+c/v to copy/paste the random map key.
- Modding:
	- *minRange*, *range*, *searchRange* for every single unit in the XML files.
	- multiple piles of the same good per building supported now (e.g. 2 gold pile at barracks). Not used right now though.


# Changed
- **PT-Script**: instead of killing, the new script **now blocks all entities instead**. Specified entities (e.g. geologists, pioneers, soldiers, vehicles, etc.) will automatically stop walking/working and even do not attack over the axis anymore. A few fixes regarding towering were also implemented. **This is still WIP, let me know of any problems**.
- Pings are now always on top of everything (FOW, Buildings, Settlers, etc).
- The new hunter-message now behaves like the other messages as well (one message per building, won't spam anymore).
- **Toolmaker hut**:
	- You can now order a specific amount of tools **in addition to infinity**, giving you the option to **prioritize a few tools over others**.
	- You can now **adjust the amount** of selected tools in the **priority-list** too (and remove a specific index completely).
- Statistics are now saved in the save-file, allowing you to see all of it even after reload.
- Instant building points: improved performance (spikes a lot) by distributing the load over multiple frames and dynamic refresh on map changes like territory, resource drops, etc.
- Range visualization: all range warriors now.
- Pause in multiplayer games: you can now click on the minimap too.