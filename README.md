# Earnbitmoon Auto Claim

Tampermonkey userscript that auto-claims the earnbitmoon.club faucet: self-learning
icon-captcha solving, Turnstile/hCaptcha handling, dynamic cooldown and reload-loop
guards.

## Install

Install the script itself, then let Tampermonkey keep it up to date:

```
https://raw.githubusercontent.com/Munem2x/earnbitmoon-auto-claim/main/EarnBitMoon.user.js
```

`@updateURL` / `@downloadURL` are baked into the metadata block, so updates are picked
up automatically once installed.

## Referral

```
https://earnbitmoon.club/?ref=844838
```

## Files

| File | Purpose |
| --- | --- |
| `EarnBitMoon.user.js` | the userscript (canonical copy) |

## Notes

- Debug/branch tracing: append `?debug=1` to the page URL.
- Learning state (known icons, odd/miss history, path stats) lives in `localStorage`
  on the site origin. The HUD's reset button wipes it.
- The HUD is the pause/resume kill switch; it gates every timer and observer.
