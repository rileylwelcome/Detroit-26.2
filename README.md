# Detroit 26.2

An offline iPhone app for marathon, lifting, nutrition, and recovery tracking. It runs on GitHub Pages and installs to your Home Screen.

## Put it online

1. Create a new **public** repository on GitHub, for example `Detroit-26.2`. GitHub Pages needs a public repository on a free account.
2. Choose **Add file > Upload files**, then drag in every file from this folder. Commit the files.
3. Go to **Settings > Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose `main` and `/ (root)`, then select **Save**.
4. Wait a minute or two. Your app will be at `https://YOUR-USERNAME.github.io/Detroit-26.2/`.

## Add it to your iPhone

1. Open that address in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.
3. Turn on **Open as Web App** if you see it, then tap **Add**.
4. Open the app from the new icon and use it from there. Safari and the Home Screen app keep separate data.

## Your data

- Everything you log stays on your phone, and nothing is sent to GitHub.
- The AI coach is off until you turn it on in Settings. When it's on, the app sends only what each question needs, and only when you tap. That goes through your own Cloudflare server to Claude. The access code stays out of your backup files.
- Go to **Settings > Export backup** every few weeks and save the file somewhere safe. Deleting the Home Screen icon can delete your logs.
- The public repository does show the plan itself, such as your starting lift weights, weight goals, and meal plan.

## Update it

Upload the changed file to the same repository. Your phone picks it up the next time you open the app online.

## What changes on its own

| When | What updates |
| --- | --- |
| You finish a workout | Your next lift targets, using the NSCA 2-for-2 rule |
| You save a run | Easy pace goal, run time goals, and race estimates after a hard effort |
| You import a Garmin CSV | Your runs and cardio, easy pace goal, weekly miles, and running history |
| You finish a weekly check-in | Calories, macros, meal portions, deload weeks, and bare-minimum weeks |

## AI coach

| You tap | What you get |
| --- | --- |
| Why and how, or Why this run | An explanation tied to your plan, saved for next time |
| Adjust today's session | A proposed change for today, based on your time, energy, soreness, and note |
| Get an AI review | A read on your week, with optional changes to approve |

The AI proposes, and `engine.js` checks each proposal against the plan's limits. Nothing applies until you approve it. Chest pain, fainting, unusual shortness of breath, or dizziness in your note gets a stop-and-get-care message, and the note isn't sent. A day-of change holds your long-term target and 2-for-2 streak for that exercise.

The server code isn't part of this repository. Never put an API key in this repository, because it's public.

## Files

- `index.html`, `styles.css`: the page and its look
- `engine.js`: the training plan and every update rule
- `app.js`: the screens and logging
- `sw.js`, `manifest.webmanifest`, `icon-*.png`: offline use and the Home Screen install
- `*.woff2`: Barlow and Barlow Condensed, under the SIL Open Font License (`OFL-LICENSE.txt`)
