# How we used AI

The requester chose what to build and reviewed the design. They asked for a console that starts empty, direct Instagram Login and an API another backend could call.

Codex designed the backend, wrote the implementation, tests and docs, then reviewed the changes and ran the checks. The automated conversation tests control Instagram’s replies, including the one that goes missing after a send. The live Meta check stopped at the webhook handshake. [What you can reproduce](docs/testing.md)
