use serde::Serialize;

pub const CONTROL_PROTOCOL_VERSION: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BuildIdentity<'a> {
    pub schema_version: u32,
    pub executable_role: &'a str,
    pub app_version: &'a str,
    pub control_protocol_version: u32,
}

impl<'a> BuildIdentity<'a> {
    pub const fn new(executable_role: &'a str, app_version: &'a str) -> Self {
        Self {
            schema_version: 1,
            executable_role,
            app_version,
            control_protocol_version: CONTROL_PROTOCOL_VERSION,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_carries_the_protocol_and_executable_role() {
        let identity = BuildIdentity::new("cli", "1.2.3");

        assert_eq!(identity.schema_version, 1);
        assert_eq!(identity.executable_role, "cli");
        assert_eq!(identity.app_version, "1.2.3");
        assert_eq!(identity.control_protocol_version, CONTROL_PROTOCOL_VERSION);
    }
}
