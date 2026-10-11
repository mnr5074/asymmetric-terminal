def rows(d):
    if not isinstance(d,dict): return []
    x=d.get('data')
    if isinstance(x,dict): x=x.get('data') or x.get('items')
    return x or []
def show(d,n=60):
    if isinstance(d,dict) and ('error' in d or 'skipped' in d): print('  ERR',str(d)[:400]); return
    for o in rows(d)[:n]:
        if 'transfer_amount' in o:
            print('  ',o.get('block_timestamp'),o.get('transaction_hash'),o.get('from_address'),(o.get('from_address_label') or '')[:28],'->',o.get('to_address'),(o.get('to_address_label') or '')[:28],round(o.get('transfer_amount') or 0),round(o.get('transfer_value_usd') or 0))
        else: print('  ',str(o)[:400])
