# Steamdeck UI Overscan Fixes for Replacement Screens

The steam deck does not have native overscan edits for the screen:

https://github.com/ValveSoftware/SteamOS/issues/1799

So this plugin is for those that have issues with replacement screens with pixels hidden behind bezels, or other overscan issues.

Sadly, this plugin does not modify Steam's Gamescope, since I couldn't find any exposed properties to modify the screen, so your games will still be overscanned. What this will do however is modify the Steam UI to have custom margins, and include the same offset to MangoHud. Hopefully the game you are playing has inbuilt UI scaling.

This plugin hasn't been uploaded to the Decky Plugin Database because it is such a specific issue, so the only way to install it is through installing it manually. If you also have this exact same specific problem, feel free to create an issue so I can submit it.

Install it by turning on Decky Loader's Experimental Settings, Developer Settings, and Install Plugin from ZIP file located in releases, or build it yourself.
(You probably will have to turn on developer mode in the General Settings if it is not on already.)
