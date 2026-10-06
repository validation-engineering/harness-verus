fn module() -> cordis_plugin_api::Module {
    cordis_harness_dynamic_text_analysis::module("fail", true)
}
cordis_plugin_api::export_plugin!(module);
