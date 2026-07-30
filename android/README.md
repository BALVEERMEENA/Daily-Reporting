# Daily Reporting — Android app (Trusted Web Activity)

This is a native Android wrapper around the deployed web app at
**https://dr2785.web.app**. It uses a **Trusted Web Activity (TWA)**, so the
native app simply opens your PWA full‑screen (no browser address bar) and always
shows the latest deploy — you don't rebuild the Android app when the website
changes.

## Download the built app (no Android Studio, phone-friendly)

Every change to the `android/` project builds an installable APK automatically
(GitHub Actions → **Build Android APK**). You can also trigger it by hand from
the **Actions** tab → *Build Android APK* → *Run workflow*.

Download the newest build straight to your phone here:

**https://github.com/BALVEERMEENA/Daily-Reporting/releases/tag/android-latest**

Tap `daily-reporting.apk`, allow your browser to install unknown apps if asked,
then open the file to install. The app opens the live site
(https://dr2785.web.app). This is a **debug** build — fine for installing on
your own phones. For Google Play you still make a signed release (see below).

## Get it onto your PC

I can't write to your computer directly, so this project lives inside the repo.
On your PC:

```bash
# one-time
git clone https://github.com/BALVEERMEENA/Daily-Reporting.git C:\DailyReporting
# later, to update
cd C:\DailyReporting
git pull
```

Then in **Android Studio**: *File → Open…* and select the
`C:\DailyReporting\android` folder (open the `android` folder, not the repo
root). Let Gradle sync finish.

## Requirements

- Android Studio (Hedgehog/Koala or newer)
- Android SDK Platform 34 (Android Studio installs it on first sync)
- JDK 17 (bundled with recent Android Studio)

## Run it

1. Plug in an Android phone with USB debugging on, or start an emulator.
2. Press **Run ▶**. The app installs and opens the reporting site.

## Build an installable APK / AAB

- **APK (share/sideload):** *Build → Build Bundle(s) / APK(s) → Build APK(s)*.
  The file lands in `app/build/outputs/apk/`.
- **AAB (Google Play):** *Build → Generate Signed Bundle / APK → Android App
  Bundle*, create a keystore when prompted, and keep it safe.

## Make it open with no address bar (Digital Asset Links)

A TWA only goes full‑screen if the website proves it trusts this app. Two files
must match:

1. **App side** — already set in `app/src/main/res/values/strings.xml`
   (`assetStatements`) and `AndroidManifest.xml`. Package id is
   `app.web.dr2785.twa`.
2. **Website side** — `web/.well-known/assetlinks.json` in this repo. Replace
   `REPLACE_WITH_YOUR_APP_SIGNING_SHA256_FINGERPRINT` with your app's signing
   certificate SHA‑256 fingerprint, then commit — GitHub Actions deploys it to
   `https://dr2785.web.app/.well-known/assetlinks.json`.

Get the fingerprint:

```bash
# from your signing keystore
keytool -list -v -keystore my-release-key.keystore -alias my-alias
```

or, if you publish on Google Play, copy the **SHA‑256** from
*Play Console → Release → Setup → App integrity → App signing*.

Until the fingerprint is filled in, the app still works but shows a thin URL bar
at the top.

## Change the app name / icon / URL

- **URL / host:** `app/src/main/res/values/strings.xml` (`launchUrl`,
  `hostName`) — and keep `assetlinks.json` in sync.
- **Name:** `appName` in the same file.
- **Icon:** replace the `ic_launcher.png` files under
  `app/src/main/res/mipmap-*/` (currently the web app icon).
- **Colors:** `app/src/main/res/values/colors.xml`.

## Note on `.apk` / `.ipa`

This produces a real Android `.apk`/`.aab`. iOS `.ipa` files can only be built
on macOS with Xcode and an Apple Developer account; on iPhone, users install the
PWA via Safari → Share → *Add to Home Screen*.
