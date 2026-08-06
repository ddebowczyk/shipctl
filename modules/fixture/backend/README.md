# Native module fixture

This disposable internal Tauri plugin proves Shep's native module rail. It is
absent from the default feature set and exposes one side-effect-free command:

```text
plugin:shep-fixture|ping
```

The fixture capability grants only `shep-fixture:allow-ping`. Product commands,
PTY infrastructure, project storage, and application state are out of scope.
