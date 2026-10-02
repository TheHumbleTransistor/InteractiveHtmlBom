import os

os.environ["INTERACTIVE_HTML_BOM_CLI_MODE"] = "1"

from InteractiveHtmlBom.core.polarity import classify  # noqa: E402


def test_stock_passives_are_not_polarized():
    assert classify('R1', 'R_0805_2012Metric', {'1', '2'}, 'Resistor', 'R_*') == 'no'
    assert classify('C12', 'C_0805_2012Metric', {'1', '2'}, 'Unpolarized capacitor', 'C_*') == 'no'
    assert classify('FB1', 'L_1206_3216Metric', {'1', '2'}, 'Ferrite bead',
                    'Inductor_* L_* *Ferrite*') == 'no'
    assert classify('F1', 'Fuseholder_Blade_Mini_Keystone_3568', {'1', '2'}, 'Fuse', '*Fuse*') == 'no'
    assert classify('R9', 'R_0603_1608Metric', {'1', '2'}, 'Resistor, small symbol', '') == 'no'


def test_polarized_parts():
    assert classify('C1', 'CP_Radial_D10.0mm_P5.00mm', {'1', '2'}, 'Polarized capacitor',
                    'CP_*') == 'yes'
    assert classify('D13', 'LED_0805_2012Metric', {'1', '2'}, 'Light emitting diode', '') == 'yes'
    assert classify('U8', 'SOIC-8_3.9x4.9mm_P1.27mm', {str(i) for i in range(1, 9)}) == 'yes'
    assert classify('L1', 'L_CommonModeChoke_TDK_ACM7060', {'1', '2', '3', '4'},
                    'Coupled inductor with ferrite core', 'Choke_* *Coil* Inductor_* L_*') == 'yes'


def test_tantalum_on_a_plain_footprint_is_not_called_unpolarized():
    assert classify('C9', 'C_1206_3216Metric', {'1', '2'}, 'Polarized capacitor', 'CP_*') == 'yes'
    assert classify('C9', 'C_1206_3216Metric', {'1', '2'}, '', '') == 'unsure'


def test_conflicting_or_missing_evidence_is_unsure():
    assert classify('D1', 'D_SMC', {'1', '2'}, 'Bidirectional transient-voltage-suppression diode',
                    'TO-???* *_Diode_* *SingleDiode* D_*') == 'unsure'
    assert classify('R1', 'R_0805_2012Metric', {'1', '2'}) == 'unsure'
    assert classify('SW1', 'SW_SPST_TL3342', {'1', '2'}, 'Push button switch', '') == 'unsure'
    assert classify('TP1', 'TestPoint_Pad_1.0x1.0mm', {'1'}, 'test point', '') == 'unsure'
