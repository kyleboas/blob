#!/usr/bin/env python3
"""Git ASKPASS helper for non-interactive authentication in sandbox environments.

Git calls this executable with the credential prompt string as the first argument
(e.g. "Username for 'https://github.com': " or "Password for 'https://...': ").
We return the appropriate value from the environment so git never opens /dev/tty.

Usage: set GIT_ASKPASS to the path of this file and ensure it is executable.
"""

import os
import sys

prompt = sys.argv[1] if len(sys.argv) > 1 else ""
if "username" in prompt.lower():
    print("x-access-token")
elif "password" in prompt.lower():
    token = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN") or ""
    print(token)
else:
    print("")
