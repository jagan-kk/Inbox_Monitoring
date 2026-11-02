Login page video
================

The sign-in page is a split layout: video on the left, form on the right.

Current clip
------------
`login.mp4` is a 19-second anime-style sunset street scene (720x1280,
H.264, silent, ~885 KB). `login-poster.jpg` is the first frame, shown while
the video loads.

Replace it
----------
1. Drop your own clip here named `login.mp4`
   - H.264 / MP4, no audio needed (the player is muted)
   - 6-20 seconds, ideally under ~2 MB
   - 1080x1920 or 720x1280 for vertical clips
2. Replace `login-poster.jpg` with a frame from it (optional but nice)

Alternatively set `LOGIN_VIDEO_URL` in `.env` to any hosted MP4 URL. That
takes precedence over this folder.

Compress a clip with ffmpeg
---------------------------
  ffmpeg -i input.mp4 -vf "scale=720:1280:flags=lanczos,format=yuv420p" ^
    -an -c:v libx264 -profile:v main -preset slow -tune animation ^
    -crf 30 -g 60 -movflags +faststart public/media/login.mp4

  ffmpeg -ss 1 -i public/media/login.mp4 -frames:v 1 -q:v 4 ^
    public/media/login-poster.jpg

Tips
----
- The clip is object-fit: cover, so it crops to fill the panel. A dark or
  low-contrast clip keeps the overlaid text readable.
- On phones the video becomes a short hero band above the form.
- If no video loads, the page falls back to an animated gradient, so
  nothing looks broken.
