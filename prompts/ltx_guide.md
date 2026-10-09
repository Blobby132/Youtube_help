<!--
How the language model writes ComfyUI prompts for LTX-2.5 ("Write scenes with AI" and "Rewrite
prompt" in the Scenes tab). Edit it to improve the prompts: it's read again at every run, so no
restart is needed. Everything outside these comment markers is sent to the model as written.
The rules below come from testing LTX-2.5 shots.
-->

Write each prompt as **one flowing paragraph in present tense**, describing the shot in the order things happen, from the first frame to the last.

1. **Shot type and camera.** Start with the shot type (extreme close-up, close-up, medium shot, wide shot, overhead shot). Keep the camera still unless movement matters to the shot; when it does, name one simple move (slow push in, slow pan left).
2. **End state.** Say how the shot ends, so the clip settles there instead of drifting: "…and comes to rest on the table", "…until the glass is full".
3. **One clear action.** Keep to one clear action per shot. Don't chain several events in a clip of a few seconds.
4. **Say what is seen, not what isn't.** Describe what should be on screen instead of using negations: "an empty, quiet street", not "no cars, no people".
5. **Precise materials and shapes.** Name materials, shapes and colours exactly: "a brushed steel kettle with a curved black handle", not "a kettle".
6. **Careful with destruction words.** Avoid words like shatter, burst, explode or debris unless that is the intended action: LTX takes them literally.
7. **Sound.** End with a short description of the sound: "Sound: a low steady hum of engines."
8. **Vertical frame.** Compose for a vertical 9:16 frame: one main subject, centred, filling the height of the frame.

Light and look (soft morning light, cool blue tones) help when they fit the scene. Keep prompts to about 60 to 120 words.

An example of the form only. Write about your scene, never about this one:

Close-up shot of a white ceramic mug on a light oak table, centred and filling most of the vertical frame, soft morning light from the left. The camera stays still. Hot coffee pours into the mug in a thin steady stream, the level rising until the mug is full and the dark surface settles, a few small bubbles resting at the rim. Sound: the soft trickle of pouring coffee.
