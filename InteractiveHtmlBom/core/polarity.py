"""Whether a part's orientation matters, for omitting pin-1 marks on parts where it doesn't."""

import re

# Two-terminal parts that can be fitted either way round.
_BIDIRECTIONAL_REFS = {'R', 'C', 'L', 'FB', 'F'}

# Descriptions KiCad's stock symbols copy onto the footprint, as prefixes ("Resistor, small symbol").
_NONPOLAR_DESCRIPTIONS = ('resistor', 'unpolarized capacitor', 'inductor', 'ferrite bead', 'fuse')
_NONPOLAR_FILTERS = {'R_*', 'C_*', 'L_*', 'Inductor_*', '*Ferrite*', '*Fuse*', 'Fuse*'}

_POLAR_DESCRIPTION = re.compile(r'(?<!un)polarized|diode|\bled\b|electrolytic|tantalum')
_POLAR_FOOTPRINT = re.compile(r'^(CP_|D_|LED_)')


def classify(ref, footprint_name, pad_names, description='', filters=''):
    # type: (str, str, set, str, str) -> str
    """Return 'yes', 'no' or 'unknown': does this part's orientation matter?

    'no' requires evidence from the schematic symbol (description or footprint filters) and none
    to the contrary. Never infer 'no' from the footprint name alone: polarized capacitors are
    often placed on plain C_ footprints.
    """
    names = {n for n in pad_names if n}
    if len(names) > 2:
        return 'yes'
    if len(names) < 2:
        return 'unknown'
    description = (description or '').strip().lower()
    filter_tokens = set((filters or '').split())

    polar = (bool(_POLAR_DESCRIPTION.search(description))
             or any(t.startswith(('CP_', 'D_', 'LED')) for t in filter_tokens)
             or bool(_POLAR_FOOTPRINT.match(footprint_name or '')))
    nonpolar = (description.startswith(_NONPOLAR_DESCRIPTIONS)
                or 'ceramic' in description
                or 'bidirectional' in description
                or bool(filter_tokens & _NONPOLAR_FILTERS))
    if polar:
        return 'unknown' if nonpolar else 'yes'
    prefix = re.match(r'[A-Za-z]*', ref or '').group(0).upper()
    if nonpolar and prefix in _BIDIRECTIONAL_REFS:
        return 'no'
    return 'unknown'
