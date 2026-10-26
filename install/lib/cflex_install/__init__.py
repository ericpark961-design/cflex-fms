"""cflex-install — C-Flex on-prem installer (docs/spec/01 §3.3).

Python because the container-profile hosts have no Node.js: Node lives inside
the images. RHEL 8 always has /usr/libexec/platform-python (3.6, dnf runs on
it) and RHEL 9 always has python3, so nothing is installed to run this.
Keep it 3.6-compatible: no dataclasses, no walrus, no capture_output/text=.
test/test_py36.py parses every module with feature_version=(3, 6).
"""

__version__ = "0.1.0"
