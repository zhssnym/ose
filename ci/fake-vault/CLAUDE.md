# Fake vault for CI

This folder is the fixture the self-test runs against on both CI runners. It is not a real
vault: it exists so `os --selftest --root ci/fake-vault` has a tree to read, write and search.

Root detection needs `CLAUDE.md` and `Inbox.md` side by side, so both files must stay here.
The `.selftest` marker file switches the self-test into its mutating mode: with it present the
page also exercises writeText, appendText, writeBinary, mkdir, rename and trash. Anything the
self-test creates lands in this folder and is thrown away with the runner.

The word selftestneedle appears in Notes/a.md and Notes/b.md and is what the search check
looks for. Do not rename these files or remove the word without changing selftest.html.
