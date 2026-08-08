# Native module fixture

This disposable internal Tauri plugin proves Shipctl's native module rail. It is
absent from the default feature set and exposes one side-effect-free command:

```text
plugin:shipctl-fixture|ping
```

The fixture capability grants only `shipctl-fixture:allow-ping`. Product commands,
PTY infrastructure, project storage, and application state are out of scope.
