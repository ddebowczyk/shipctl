mod build 'ops/build/justfile'
mod check 'ops/check/justfile'
mod execution 'ops/execution/justfile'
mod instance-control 'ops/instance-control/justfile'
mod module-control 'ops/module-control/justfile'
mod modularity 'ops/modularity/justfile'
mod ops 'ops/justfile'
mod test 'ops/test/justfile'
mod upstream 'ops/upstream/justfile'

default:
    @just --list --list-submodules
