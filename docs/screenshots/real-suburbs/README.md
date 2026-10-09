# Real suburbs: the game next to the 2024 photo

Epic #119 asks every sub-issue for "before/after shots from the same camera positions next to the real 2024 photo".
Each sheet here is the game's frame on the left (medium tier, mission t01, seed 7, chase camera, HUD hidden) and on the
right a north-up crop of the LINZ / Auckland Council 2024–25 aerial photo (CC BY 4.0) round the point the camera looks
at. On the photo the yellow ring is the camera and the line runs to the look point.

Made with `e2e/landmark-shots.mjs` and `tools/linz/photo-compare.py` (see `tools/linz/README.md`, "Game shots next to
the 2024 photo"). Headless SwiftShader on 2026-10-09, on the stack's top layer over `master` (`57c344d`).

## #124: landmark buildings (hospitals, malls, stations)

| View | Sheet | What lines up | What doesn't |
|---|---|---|---|
| Auckland City Hospital, Grafton | [124-grafton_hospital.jpg](124-grafton_hospital.jpg) | The hospital buildings at the Domain's west edge, the motorway junction behind | — |
| Middlemore Hospital | [124-middlemore.jpg](124-middlemore.jpg) | The hospital east of the rail line, the Tāmaki estuary to the north-east | — |
| North Shore Hospital, Takapuna | [124-north_shore_hospital.jpg](124-north_shore_hospital.jpg) | The hospital on Lake Pupuke's south-west shore, the motorway to the west | — |
| Sylvia Park | [124-sylvia_park.jpg](124-sylvia_park.jpg) | The mall north of the SH1 junction, the industrial blocks to the east | — |
| Westfield Albany | [124-albany.jpg](124-albany.jpg) | The mall at the look point | It reads as flat grey slabs; the stadium and the lake north of it aren't there; the ground round it is the procedural grid |
| Ellerslie station | [124-ellerslie_station.jpg](124-ellerslie_station.jpg) | Both platforms along the rail ribbon, SH1 east of the line, the racecourse behind | — |
| Henderson | [124-henderson.jpg](124-henderson.jpg) | The town centre along the rail line, the industrial area to the south-west | — |

The scatters (trees, houses) stream in after the camera moves. On the first run Ellerslie had not streamed when its
120 s wait ran out: bare ground and tree shadows. It was shot again alone with `--idle=360`.
