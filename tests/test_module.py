import os

# Registering the action plugin outside KiCad trips a KiCad 10 assertion that aborts under pytest.
os.environ["INTERACTIVE_HTML_BOM_CLI_MODE"] = "1"


def test_module_import():
    import InteractiveHtmlBom  # noqa


def test_kicad_parser_import():
    from InteractiveHtmlBom.ecad import kicad  # noqa
