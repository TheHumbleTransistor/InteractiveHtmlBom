import os

os.environ["INTERACTIVE_HTML_BOM_CLI_MODE"] = "1"

from InteractiveHtmlBom.core.polarity import classify, silk_symmetric  # noqa: E402

# R_0805-style silk: a line above and below the body.
TWO_BARS = [((-0.2, -0.7), (0.2, -0.7)), ((-0.2, 0.7), (0.2, 0.7))]
# The same with a polarity tick at one end.
TWO_BARS_AND_TICK = TWO_BARS + [((-1.5, -0.5), (-1.5, 0.5))]


def test_silk_symmetry():
    assert silk_symmetric(TWO_BARS) is True
    assert silk_symmetric(TWO_BARS_AND_TICK) is False
    assert silk_symmetric([]) is None


def test_stock_passives_with_symmetric_silk_are_not_polarized():
    assert classify('R1', 'R_0805_2012Metric', {'1', '2'}, 'Resistor', 'R_*', True) == 'no'
    assert classify('C12', 'C_0805_2012Metric', {'1', '2'}, 'Unpolarized capacitor', 'C_*',
                    True) == 'no'
    assert classify('FB1', 'L_1206_3216Metric', {'1', '2'}, 'Ferrite bead',
                    'Inductor_* L_* *Ferrite*', True) == 'no'
    assert classify('F1', 'Fuseholder_Blade_Mini_Keystone_3568', {'1', '2'}, 'Fuse', '*Fuse*',
                    True) == 'no'
    assert classify('R9', 'R_0603_1608Metric', {'1', '2'}, 'Resistor, small symbol', '',
                    True) == 'no'


def test_asymmetric_or_missing_silk_is_never_no():
    assert classify('L2', 'L_Bourns_SRP1038C_10.0x10.0mm', {'1', '2'}, 'Inductor',
                    'Choke_* *Coil* Inductor_* L_*', False) == 'unknown'
    assert classify('R1', 'R_0805_2012Metric', {'1', '2'}, 'Resistor', 'R_*', None) == 'unknown'


def test_polarized_parts():
    assert classify('C1', 'CP_Radial_D10.0mm_P5.00mm', {'1', '2'}, 'Polarized capacitor',
                    'CP_*', False) == 'yes'
    assert classify('D13', 'LED_0805_2012Metric', {'1', '2'}, 'Light emitting diode', '',
                    False) == 'yes'
    assert classify('U8', 'SOIC-8_3.9x4.9mm_P1.27mm', {str(i) for i in range(1, 9)}) == 'yes'
    assert classify('L1', 'L_CommonModeChoke_TDK_ACM7060', {'1', '2', '3', '4'},
                    'Coupled inductor with ferrite core', 'Choke_* *Coil* Inductor_* L_*') == 'yes'


def test_tantalum_on_a_plain_symmetric_footprint_is_not_called_unpolarized():
    assert classify('C9', 'C_1206_3216Metric', {'1', '2'}, 'Polarized capacitor', 'CP_*',
                    True) == 'yes'
    assert classify('C9', 'C_1206_3216Metric', {'1', '2'}, '', '', True) == 'unknown'


def test_conflicting_or_missing_evidence_is_unknown():
    assert classify('D1', 'D_SMC', {'1', '2'}, 'Bidirectional transient-voltage-suppression diode',
                    'TO-???* *_Diode_* *SingleDiode* D_*', False) == 'unknown'
    assert classify('R1', 'R_0805_2012Metric', {'1', '2'}, silk_symmetric=True) == 'unknown'
    assert classify('SW1', 'SW_SPST_TL3342', {'1', '2'}, 'Push button switch', '', True) == 'unknown'
    assert classify('TP1', 'TestPoint_Pad_1.0x1.0mm', {'1'}, 'test point', '') == 'unknown'
