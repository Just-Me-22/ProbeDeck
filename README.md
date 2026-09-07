# ProbeDeck

A diagnostics panel that lives inside Discord, for people writing themes and plugins for
it. Fourteen lenses, all idle until you open the panel.

It exists because the normal loop for this work is slow. You change a selector, rebuild,
reload, wait fifteen seconds, and find out you guessed wrong. Most of what is here is
aimed at getting the answer before the rebuild instead of after it.

This is a working instrument rather than a finished product. Some of it is shaped around
the setup it was built on, and the section at the bottom says which parts.

## Installing

You need an Equicord or Vencord source build. From the root of that checkout:

```bash
git clone https://github.com/Just-Me-22/ProbeDeck src/userplugins/probeDeck
pnpm build
```

Reload Discord and turn on **ProbeDeck**.

## Getting around

**F9** opens and closes it. **F10** clears what it has collected and puts the panel back
in the corner. Once it is open, click a tab, press a number from 1 to 9, or use the left
and right arrows.

`Ctrl+Alt+P` and `Ctrl+Alt+R` still work. F keys are the better choice because they carry
no character, so Windows never runs them through its AltGr translation and nothing can
leak into the message box behind the panel.

Drag the top bar to move it. The panel ignores the mouse everywhere else on purpose, so
the element inspector can see through it to what you are clicking.

## For theme work

**inspect** is the one to start with. Click any element and it prints the box chain, the
layout its parent is applying, which rule actually won each property, and what is covering
it. Above all that it hands you **ready to paste selectors** for the element and its
ancestors, with the build hash already stripped and a live match count on each, so you can
tell at a glance whether one is specific enough.

**css** is a live scratchpad. Type a rule, press Ctrl+Enter, and it applies immediately.
No build and no reload. It then reads back what the browser actually accepted and tells
you how many elements each selector matched, which catches the two usual dead ends: a rule
silently rejected over a brace, and a selector that matches nothing at all. Nothing here
survives a reload, which is the point.

**cost** takes a selector and reports what it costs the browser to run, and which parts of
it are expensive on a hover or scroll path.

**audit** sweeps for overlapping panels and seams.

**diff** watches a set of landmark selectors and tells you which class names changed, which
is what you want after Discord ships an update and half your theme stops applying.

## For plugin work

**find** searches every webpack module for words they must all contain.

**regex** is a patch tester. Give it a find string and a regex and it tells you how many
modules the find matches, how many times the regex hits in each, and what the capture
groups hold. A count of zero or of two or more is the reason most patches quietly fail.
Add a third part and it shows you what the rewritten source would say:

```
<find> | <regex> | <replacement>
```

**rest** taps the requests Discord's own client makes: method, path, body, status and
duration, newest first, filterable. This is usually faster than reading Discord's source
to work out which endpoint does a thing. Click it in the UI and read the request.

**patches** shows which registered patches have landed. **stores** searches Flux stores by
name.

## For performance

**perf** is frame timing. **tasks** records main thread blocks over a threshold you set.
**churn** watches how much DOM is being created and destroyed. **boot** shows how long each
startup milestone took.

## Things worth knowing

The **rest** lens captures request bodies, and those can contain what you typed, including
message content. The copy button copies the whole panel, so read it before pasting it
anywhere.

The **css** lens writes into a live style tag. It is for trying things, not keeping them.
Copy anything you want into your theme before you reload.

The panel is `pointer-events: none` apart from the top bar, the tabs and the query box.
That is deliberate and is what lets the inspector click through it.

## What is shaped around one setup

Honest notes for anyone else installing it:

- The landmark selectors that **diff** and **audit** watch are the ones from the theme it
  was built alongside. They are a good starting set for Discord, but they are not yours.
- The AltGr handling exists because of a Polish keyboard layout. It costs nothing if that
  is not you.
- It assumes an Equicord or Vencord source build, since half of it reads the webpack module
  table directly.

## Licence

GPL-3.0-or-later, same as Vencord.
