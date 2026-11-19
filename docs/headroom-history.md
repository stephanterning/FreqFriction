# Headroom history

Deferred concept for a separate tool. FreqFriction’s current focus is frequency masking.

Arm the recorder and play a passage or the whole arrangement. Capture the stereo sample peak at the device input on Main immediately before the limiter. Plot the peak history against Live’s transport in bars and beats. Keep the history available after playback so the user can click any peak and zoom into the surrounding beats.

Show selected tracks and buses on the same timeline, with their measurement points labeled. For example, compare Kick and Bass Bus Post Mixer with Main to see which signals were active as the peak rose. Preserve the highest sample peak in each displayed time interval when zooming out.

The traces can guide a listening check. Phase, routing, bus processing and latency affect how signals combine at Main. A source and its parent bus also contain some of the same audio. Validate timing across those paths before drawing conclusions about individual contributions.

Open design question for a prototype: how should the timeline distinguish repeated passes through a loop?
