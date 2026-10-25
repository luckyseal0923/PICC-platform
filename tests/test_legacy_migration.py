import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('legacy_plan',Path(__file__).resolve().parents[1]/'scripts'/'prepare-legacy-mysql.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class LegacyMigration(unittest.TestCase):
    def row(self,**extra):
        return {'id':1,'task_id':'OLD-TEST-001','patient_name':'驗證甲D','mrn':'00123456','bed_no':'0001','status':'完成','created_at':'2026-10-01 00:05:00','completed_at':'2026-10-01 01:05:00','operator':'驗證員D','completed_by':'驗證員D','claimed_by':'驗證員D','claimed_at':'2026-10-01 00:10:00','difficulty':'簡單','insert_site':'右上臂','vessel':'Basilic','catheter_type':'單腔 PICC','catheter_length':'40.00','remark':'',**extra}

    def test_identifiers_notes_and_times_are_preserved(self):
        item=module.normalize(self.row(remark="含單引號 ' 的原始備註"),'synthetic')
        self.assertEqual(item['mrn'],'00123456')
        self.assertEqual(item['bedNo'],'0001')
        self.assertEqual(item['createdAt'],'2026-09-30T16:05:00+00:00')
        self.assertEqual(item['catheterType'],'單腔PICC')
        self.assertEqual(item['remark'],"含單引號 ' 的原始備註")

    def test_cancelled_legacy_report_is_not_counted_as_a_completed_procedure(self):
        item=module.normalize(self.row(remark='取消。改CVP'),'synthetic')
        self.assertEqual(item['status'],'cancelled')
        self.assertEqual(item['cancelReason'],'已有／改用其他管路')
        self.assertEqual(item['cancelledAt'],'2026-09-30T17:05:00+00:00')
        self.assertIsNone(item['completedAt'])
        self.assertIsNone(item['operatorName'])
        self.assertIsNone(item['difficulty'])
        self.assertEqual(item['legacyReporter'],'驗證員D')
        self.assertIn('原始備註：取消。改CVP',item['cancelDetail'])

    def test_missing_cancellation_reason_is_not_invented(self):
        item=module.normalize(self.row(remark='取消施打'),'synthetic')
        self.assertEqual(item['cancelReason'],'未記錄（舊案）')
        self.assertIn('cancellation_reason_missing',item['flags'])

    def test_ambiguous_cancellation_stops_for_review(self):
        for note in ['不取消，已完成','取消後已完成','取消失敗']:
            with self.assertRaises(ValueError):
                module.normalize(self.row(remark=note),'synthetic')

    def test_pending_placeholders_do_not_become_performers(self):
        item=module.normalize(self.row(status='待預約',operator='undefined',completed_by=None,completed_at=None,claimed_by=None,claimed_at=None,difficulty='undefined'),'synthetic')
        self.assertEqual(item['status'],'pending')
        self.assertIsNone(item['operatorName'])
        self.assertIsNone(item['difficulty'])

    def test_stable_source_identity_and_no_duplicate_case_numbers(self):
        row=self.row()
        one=module.normalize(row,'synthetic')
        self.assertEqual(one['id'],module.normalize(row,'synthetic')['id'])
        with self.assertRaises(ValueError):
            module.prepare([row,{**row,'id':2}],'fake-hash','synthetic')

    def test_unknown_difficulty_keeps_its_original_label(self):
        item=module.normalize(self.row(difficulty='一般'),'synthetic')
        self.assertEqual(item['difficulty'],'一般')
        self.assertIn('legacy_difficulty_label_preserved',item['flags'])

if __name__=='__main__':
    unittest.main()
