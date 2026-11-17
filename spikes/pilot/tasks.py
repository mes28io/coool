"""Evaluation tasks on built-in iOS apps: goal + typed inputs + reset + verifier + scripted oracle."""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from typing import Callable

from device import Action, Device, Screen


def simctl(*args) -> str:
    return subprocess.run(["xcrun", "simctl", *args], capture_output=True, text=True).stdout.strip()


@dataclass
class Task:
    name: str
    bundle: str
    goal: str
    inputs: dict
    plan: list[str]                         # oracle waypoints: regexes over Action.describe()
    verify: Callable[[Device, Screen], bool]
    reset: Callable[[Device], None] = lambda d: None
    max_steps: int = 14
    recover: list[str] = field(default_factory=list)  # oracle: try these before scrolling


def screen_has(s: Screen, *needles: str) -> bool:
    blob = " ".join(s.texts + [e.label + " " + str(e.value) for e in s.elements]).lower()
    return all(n.lower() in blob for n in needles)


def oracle(task: Task, s: Screen, ptr: int) -> tuple[Action, int]:
    """Gold action + new plan pointer. Strictly follows the waypoint regexes; scrolls if the next
    waypoint is not on screen yet."""
    if s.app == "System alert":
        for pat in (r'"Allow While Using App"', r'"Allow"$', r'"Not Now"', r'"Don.t Allow"', r'"OK"'):
            for a in s.actions:
                if re.search(pat, a.describe()):
                    return a, ptr
        return next(a for a in s.actions if a.verb == "stuck"), ptr
    if task.plan[ptr] == "DONE":
        return next(a for a in s.actions if a.verb == "done"), ptr
    rx = re.compile(task.plan[ptr], re.I)
    for a in s.actions:
        if rx.search(a.describe()):
            return a, ptr + 1
    for r in task.recover:
        for a in s.actions:
            if re.search(r, a.describe(), re.I):
                return a, ptr
    return next((a for a in s.actions if a.verb == "scroll_down"), s.actions[-1]), ptr


def make_tasks(udid: str, run: int) -> list[Task]:
    def dark_reset(d):
        simctl("ui", udid, "appearance", "light")
        d.terminate("com.apple.Preferences")

    def term(b):
        return lambda d: d.terminate(b)

    first, last, phone = "Ada", f"Pilot{run}", f"555010{run}"
    rtitle = f"Buy oat milk {run}"
    return [
        Task("dark_mode", "com.apple.Preferences",
             "Switch the iPhone to Dark Mode (dark appearance).", {},
             [r'tap Button "Appearance"', r'tap Button "[^"]*Dark"$', "DONE"],
             lambda d, s: simctl("ui", udid, "appearance") == "dark", dark_reset),
        Task("ios_version", "com.apple.Preferences",
             "Open the screen in Settings that shows the iOS version number, then stop there.", {},
             [r'tap Button "General"$', r'tap Button "About"$', "DONE"],
             lambda d, s: screen_has(s, "iOS Version"), term("com.apple.Preferences")),
        Task("text_size", "com.apple.Preferences",
             "Open the 'Display & Text Size' settings page (it is under Accessibility).", {},
             [r'tap Button "Accessibility"$', r'tap (Cell|Button) "Display & Text Size"', "DONE"],
             lambda d, s: screen_has(s, "Bold Text") and screen_has(s, "Larger Text"),
             term("com.apple.Preferences")),
        Task("safari_link", "com.apple.mobilesafari",
             "In Safari, open the website example.com and then follow its 'Learn more' link.", {"url": "example.com"},
             [r'type <url> into TextField "Address"', r"press the keyboard", r'tap Link "Learn more"', "DONE"],
             lambda d, s: screen_has(s, "iana"), term("com.apple.mobilesafari")),
        Task("contact", "com.apple.MobileAddressBook",
             "Create a new contact with the given first name, last name and mobile phone number, and save it.",
             {"first_name": first, "last_name": last, "phone": phone},
             [r'tap Button "Add"$', r'type <first_name> into TextField "First name"',
              r'type <last_name> into TextField "Last name"', r'tap Cell "add phone"',
              r'type <phone> into TextField "mobile', r'tap Button "Done"', "DONE"],
             lambda d, s: screen_has(s, f"{first} {last}") and phone in re.sub(r"\D", "", " ".join(e.label for e in s.elements)),
             term("com.apple.MobileAddressBook"), recover=[r'tap Button "Back"$']),
        Task("reminder", "com.apple.reminders",
             "Add a new reminder with the given title.", {"title": rtitle},
             [r'tap Button "New Reminder"', r'type <title> into TextField "Title"$', r'tap Button "Done"', "DONE"],
             lambda d, s: screen_has(s, rtitle) and not s.keyboard, term("com.apple.reminders")),
        Task("maps_search", "com.apple.Maps",
             "Search Apple Maps for the given place and open a matching place card from the results.",
             {"place": "Cupertino"},
             [r'type <place> into SearchField', r'tap Button "Cupertino', "DONE"],
             lambda d, s: not s.keyboard and screen_has(s, "Close") and (screen_has(s, "Plan") or any("Cupertino" in t for t in s.texts)),
             term("com.apple.Maps"), recover=[r'tap Button "Close"$']),
    ]
