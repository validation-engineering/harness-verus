fn module() -> cordis_plugin_api::Module {
    cordis_harness_dynamic_text_analysis::module("v1", false)
}
cordis_plugin_api::export_plugin!(module);
