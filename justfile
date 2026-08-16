mod architecture 'ops/architecture/justfile'
mod build 'ops/build/justfile'
mod check 'ops/check/justfile'
mod execution 'ops/execution/justfile'
mod instance-control 'ops/instance-control/justfile'
mod message-bus 'ops/message-bus/justfile'
mod module-control 'ops/module-control/justfile'
mod modularity 'ops/modularity/justfile'
mod ops 'ops/justfile'
mod repository 'ops/repository/justfile'
mod test 'ops/test/justfile'
mod upstream 'ops/upstream/justfile'
mod version 'ops/version/justfile'

default:
    @just --list --list-submodules
